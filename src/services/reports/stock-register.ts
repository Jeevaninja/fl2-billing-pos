/** Phase 23 stock register (D4): opening · inward · sales · other · closing, from the shared stock ledger. */
import type { SqlClient } from '../../db/client.js';
import type { SizeCode } from '../../domain/types.js';
import type { ReportHeader } from './shared.js';
import { stockLedger } from './stock-ledger.js';

export interface StockRegisterRow {
  skuId: string;
  skuCode: string;
  name: string;
  sizeCode: SizeCode;
  categoryName: string;
  centerName: string;
  isActive: boolean;
  openingQty: number;
  /** GRN receipts. */
  inwardQty: number;
  /** Bottles out, net of restocked returns. */
  salesQty: number;
  /** New-item opening counts and adjustments. */
  otherQty: number;
  closingQty: number;
}

export interface StockRegister extends ReportHeader {
  rows: StockRegisterRow[];
}

export async function stockRegister(db: SqlClient, head: ReportHeader): Promise<StockRegister> {
  const rows = await stockLedger(db, head.range);
  return {
    ...head,
    rows: rows.map((r) => ({
      skuId: r.skuId,
      skuCode: r.skuCode,
      name: r.name,
      sizeCode: r.sizeCode,
      categoryName: r.categoryName,
      centerName: r.centerName,
      isActive: r.isActive,
      openingQty: r.openingQty,
      inwardQty: r.inwardQty,
      salesQty: r.salesQty,
      otherQty: r.openingCountQty + r.adjustmentQty,
      closingQty: r.closingQty,
    })),
  };
}
