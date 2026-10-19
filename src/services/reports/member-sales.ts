/**
 * Member-wise sales (Phase 24 §1.2, D1): only bills the cashier actually tagged to a member (F2).
 * Untagged bills stay on their own line — never spread over members. The system records no gate entry
 * or exit, so each visit shows the times of its first and last bill, labelled as exactly that.
 * A reversal inherits its bill's member, so voids net out under the same member.
 */
import type { SqlClient } from '../../db/client.js';
import { type DbInt, type Paise, toPaise } from '../../domain/money.js';
import type { SizeCode } from '../../domain/types.js';
import { IN_RANGE, int, type ReportHeader, sum } from './shared.js';

export interface MemberVisitItem {
  name: string;
  sizeCode: SizeCode;
  qty: number;
  amountPaise: Paise;
}

export interface MemberVisit {
  businessDate: string;
  firstBillAt: Date;
  lastBillAt: Date;
  billNos: number[];
  items: MemberVisitItem[];
  totalPaise: Paise;
}

export interface MemberSalesRow {
  memberId: string;
  membershipNo: string;
  name: string;
  visits: MemberVisit[];
  totalQty: number;
  totalPaise: Paise;
}

export interface MemberSales extends ReportHeader {
  members: MemberSalesRow[];
  /** Bills not tagged to any member. */
  untagged: { billCount: number; qty: number; totalPaise: Paise };
  /** Σ members + untagged = the Sales Summary total. */
  totalPaise: Paise;
}

export async function memberSales(db: SqlClient, head: ReportHeader): Promise<MemberSales> {
  const params = [head.range.startDate, head.range.endDate];
  const { rows: visits } = await db.query<{
    member_id: string;
    membership_no: string;
    member_name: string;
    business_date: string;
    first_at: Date;
    last_at: Date;
    bill_nos: number[];
    total: DbInt;
  }>(
    `SELECT m.id AS member_id, m.membership_no, m.display_name AS member_name, d.business_date::text AS business_date,
            min(b.created_at) AS first_at, max(b.created_at) AS last_at,
            array_agg(b.bill_no ORDER BY b.bill_no) AS bill_nos, sum(b.total_paise)::text AS total
       FROM bills b
       JOIN business_days d ON d.id = b.business_day_id
       JOIN members m ON m.id = b.member_id
      WHERE b.${IN_RANGE} AND b.status <> 'OPEN'
      GROUP BY m.id, m.membership_no, m.display_name, d.business_date
      ORDER BY m.membership_no, d.business_date`,
    params,
  );
  const { rows: items } = await db.query<{ member_id: string; business_date: string; name: string; size_code: SizeCode; qty: DbInt; amount: DbInt }>(
    `SELECT b.member_id, d.business_date::text AS business_date, max(i.display_name_snapshot) AS name, max(i.size_code_snapshot) AS size_code,
            sum(i.qty)::text AS qty, sum(i.line_total_paise)::text AS amount
       FROM bill_items i
       JOIN bills b ON b.id = i.bill_id
       JOIN business_days d ON d.id = b.business_day_id
      WHERE b.${IN_RANGE} AND b.status <> 'OPEN' AND b.member_id IS NOT NULL
      GROUP BY b.member_id, d.business_date, i.sku_id
     HAVING sum(i.qty) <> 0
      ORDER BY b.member_id, d.business_date, min(i.created_at)`,
    params,
  );
  const untagged = await (async () => {
    const { rows } = await db.query<{ n: number; qty: DbInt; total: DbInt }>(
      `SELECT count(*) FILTER (WHERE b.bill_kind = 'SALE')::int AS n,
              coalesce((SELECT sum(i.qty) FROM bill_items i JOIN bills x ON x.id = i.bill_id
                         WHERE x.${IN_RANGE} AND x.status <> 'OPEN' AND x.member_id IS NULL), 0)::text AS qty,
              coalesce(sum(b.total_paise), 0)::text AS total
         FROM bills b
        WHERE b.${IN_RANGE} AND b.status <> 'OPEN' AND b.member_id IS NULL`,
      params,
    );
    const r = rows[0]!;
    return { billCount: int(r.n), qty: int(r.qty), totalPaise: toPaise(r.total) };
  })();

  const itemsOf = new Map<string, MemberVisitItem[]>();
  for (const i of items) {
    const key = `${i.member_id}|${i.business_date}`;
    const list = itemsOf.get(key) ?? [];
    list.push({ name: i.name, sizeCode: i.size_code, qty: int(i.qty), amountPaise: toPaise(i.amount) });
    itemsOf.set(key, list);
  }

  const members: MemberSalesRow[] = [];
  for (const v of visits) {
    let member = members[members.length - 1];
    if (!member || member.memberId !== v.member_id) {
      member = { memberId: v.member_id, membershipNo: v.membership_no, name: v.member_name, visits: [], totalQty: 0, totalPaise: 0n };
      members.push(member);
    }
    const visitItems = itemsOf.get(`${v.member_id}|${v.business_date}`) ?? [];
    const visit: MemberVisit = {
      businessDate: v.business_date,
      firstBillAt: v.first_at,
      lastBillAt: v.last_at,
      billNos: v.bill_nos.map(int),
      items: visitItems,
      totalPaise: toPaise(v.total),
    };
    member.visits.push(visit);
    member.totalQty += visitItems.reduce((n, i) => n + i.qty, 0);
    member.totalPaise += visit.totalPaise;
  }
  return { ...head, members, untagged, totalPaise: sum(members, (m) => m.totalPaise) + untagged.totalPaise };
}
