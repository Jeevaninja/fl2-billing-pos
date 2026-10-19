/**
 * Settings → Revenue Centers (Phase 22, migration 0016). Departments became the manager's list of
 * revenue centers: Liquor (the core bar), Kitchen, Cigarettes, Cool Drinks, … Every bill line, brand,
 * item category and expense category carries one, so each center's P&L is exact. The code is the key
 * — generated from the name, never changed; the name, order, KOT station, stock tracking and active
 * flag are editable. Never deleted (disable instead). Liquor's behaviour is locked.
 */
import type { SqlClient, SqlDatabase } from '../db/client.js';
import { NotFoundError, PosError, PosErrorCode, withPosErrors } from '../db/errors.js';
import type { DepartmentCode, DepartmentStation } from '../domain/types.js';
import { maybeOne, one } from './rows.js';

export const MAX_DEPARTMENT_NAME = 30;
export const DEPARTMENT_STATIONS = ['BAR', 'KITCHEN', 'NONE'] as const satisfies readonly DepartmentStation[];

export interface Department {
  code: DepartmentCode;
  name: string;
  /** Where its items' KOT prints; NONE = no ticket (a service). */
  kotStation: DepartmentStation;
  tracksStock: boolean;
  isActive: boolean;
  sortOrder: number;
  /** Active items (SKUs of active brands) in it. */
  itemCount: number;
  /** Σ bottles / units on hand over its items. */
  onHandQty: number;
}

export interface NewDepartment {
  name: string;
  kotStation: DepartmentStation;
  tracksStock: boolean;
}

export interface DepartmentPatch {
  name?: string;
  kotStation?: DepartmentStation;
  tracksStock?: boolean;
  isActive?: boolean;
  move?: 'up' | 'down';
}

interface DepartmentRow {
  code: DepartmentCode;
  name: string;
  kot_station: DepartmentStation;
  tracks_stock: boolean;
  is_active: boolean;
  sort_order: number;
  item_count: number;
  on_hand_qty: number;
}

const SELECT_DEPARTMENTS = `
  SELECT d.code, d.name, d.kot_station, d.tracks_stock, d.is_active, d.sort_order,
         (SELECT count(*)::int FROM skus k JOIN products p ON p.id = k.product_id
           WHERE p.department = d.code AND k.is_active AND p.is_active) AS item_count,
         (SELECT coalesce(sum(s.on_hand_qty), 0)::int FROM skus k JOIN products p ON p.id = k.product_id JOIN sku_stock s ON s.sku_id = k.id
           WHERE p.department = d.code) AS on_hand_qty
    FROM departments d`;

function mapDepartment(r: DepartmentRow): Department {
  return {
    code: r.code,
    name: r.name,
    kotStation: r.kot_station,
    tracksStock: r.tracks_stock,
    isActive: r.is_active,
    sortOrder: r.sort_order,
    itemCount: r.item_count,
    onHandQty: r.on_hand_qty,
  };
}

/** Trimmed, spaces collapsed; RangeError when blank or too long. */
export function cleanDepartmentName(name: string): string {
  const text = name.trim().replace(/\s+/g, ' ');
  if (text === '') throw new RangeError('a revenue center needs a name');
  if (text.length > MAX_DEPARTMENT_NAME) throw new RangeError(`a revenue center name must be at most ${MAX_DEPARTMENT_NAME} characters`);
  return text;
}

/** "Cool Drinks" → COOL_DRINKS; a name with no letters at its start gets a C_ prefix. */
export function codeFromName(name: string): string {
  const code = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 26);
  return /^[A-Z]/.test(code) && code.length >= 2 ? code : `C_${code || 'CENTER'}`.slice(0, 26);
}

/** A department code's shape (the database decides whether it exists). */
export function checkDepartmentCode(code: string, name = 'department'): DepartmentCode {
  if (typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{1,29}$/.test(code)) throw new RangeError(`${name} must be a revenue center code such as LIQUOR or KITCHEN`);
  return code;
}

function checkStation(station: string, name: string): DepartmentStation {
  if (!(DEPARTMENT_STATIONS as readonly string[]).includes(station)) throw new RangeError(`${name} must be one of ${DEPARTMENT_STATIONS.join(', ')}`);
  return station as DepartmentStation;
}

export async function getDepartment(db: SqlClient, code: string): Promise<Department> {
  const row = await maybeOne<DepartmentRow>(db, `${SELECT_DEPARTMENTS} WHERE d.code = $1`, [code]);
  if (!row) throw new NotFoundError('department', code);
  return mapDepartment(row);
}

/**
 * The center a brand, item category or expense category is being pointed at: it must exist
 * (NotFoundError) and be active (PS002).
 */
export async function requireActiveDepartment(db: SqlClient, code: string): Promise<DepartmentCode> {
  const row = await maybeOne<{ name: string; is_active: boolean }>(db, `SELECT name, is_active FROM departments WHERE code = $1`, [code]);
  if (!row) throw new NotFoundError('department', code);
  if (!row.is_active) throw new PosError(PosErrorCode.ILLEGAL_TRANSITION, `revenue center ${row.name} is disabled`);
  return code;
}

export class DepartmentService {
  constructor(private readonly db: SqlDatabase) {}

  /** In display order (then name). Active ones only unless `includeInactive`. */
  async listDepartments({ includeInactive = false }: { includeInactive?: boolean } = {}): Promise<Department[]> {
    const { rows } = await this.db.query<DepartmentRow>(
      `${SELECT_DEPARTMENTS} ${includeInactive ? '' : 'WHERE d.is_active'} ORDER BY d.sort_order, lower(d.name)`,
    );
    return rows.map(mapDepartment);
  }

  /** Adds a center at the end of the order; its code comes from the name (COOL_DRINKS, then COOL_DRINKS_2…). */
  async createDepartment(input: NewDepartment): Promise<Department> {
    const name = cleanDepartmentName(input.name);
    const station = checkStation(input.kotStation, 'kotStation');
    if (typeof input.tracksStock !== 'boolean') throw new RangeError('tracksStock must be true or false');
    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        await tx.query(`LOCK TABLE departments IN SHARE ROW EXCLUSIVE MODE`);
        const base = codeFromName(name);
        let code = base;
        for (let n = 2; await maybeOne(tx, `SELECT 1 FROM departments WHERE code = $1`, [code]); n++) code = `${base}_${n}`;
        await tx.query(
          `INSERT INTO departments (code, name, kot_station, tracks_stock, sort_order)
           VALUES ($1, $2, $3, $4, (SELECT coalesce(max(sort_order), 0) + 1 FROM departments))`,
          [code, name, station, input.tracksStock],
        );
        return getDepartment(tx, code);
      }),
    );
  }

  /**
   * Renames, changes the KOT station or stock tracking, disables / enables, or moves one place.
   * The database refuses changing Liquor, turning stock tracking off with stock on hand, and
   * disabling a center that still has active items (PS002).
   */
  async updateDepartment(code: string, patch: DepartmentPatch): Promise<Department> {
    const name = patch.name === undefined ? undefined : cleanDepartmentName(patch.name);
    const station = patch.kotStation === undefined ? undefined : checkStation(patch.kotStation, 'kotStation');
    return withPosErrors(() =>
      this.db.transaction(async (tx) => {
        await tx.query(`LOCK TABLE departments IN SHARE ROW EXCLUSIVE MODE`);
        const current = await getDepartment(tx, code);
        if (name !== undefined || station !== undefined || patch.tracksStock !== undefined || patch.isActive !== undefined) {
          await tx.query(
            `UPDATE departments
                SET name = coalesce($2, name), kot_station = coalesce($3, kot_station),
                    tracks_stock = coalesce($4, tracks_stock), is_active = coalesce($5, is_active)
              WHERE code = $1`,
            [code, name ?? null, station ?? null, patch.tracksStock ?? null, patch.isActive ?? null],
          );
        }
        if (patch.move) {
          const neighbour = await maybeOne<{ code: string; sort_order: number }>(
            tx,
            patch.move === 'up'
              ? `SELECT code, sort_order FROM departments WHERE sort_order < $1 ORDER BY sort_order DESC LIMIT 1`
              : `SELECT code, sort_order FROM departments WHERE sort_order > $1 ORDER BY sort_order ASC LIMIT 1`,
            [current.sortOrder],
          );
          if (neighbour) {
            await tx.query(`UPDATE departments SET sort_order = $2 WHERE code = $1`, [neighbour.code, current.sortOrder]);
            await tx.query(`UPDATE departments SET sort_order = $2 WHERE code = $1`, [code, neighbour.sort_order]);
          }
        }
        return one<DepartmentRow>(tx, `${SELECT_DEPARTMENTS} WHERE d.code = $1`, [code]).then(mapDepartment);
      }),
    );
  }
}
