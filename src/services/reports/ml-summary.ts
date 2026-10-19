/**
 * ML / Unit Details (Phase 24 R2): bottles × the SKU's nominal volume, grouped by excise group and
 * bottle size, for Sale and Closing. Volume is a static label per sealed bottle (skus.volume_ml); stock
 * itself is never tracked in ml. Integer ml throughout.
 */
import type { ExciseGroup } from '../../domain/types.js';
import type { StockLedgerRow } from './stock-ledger.js';

export const EXCISE_GROUP_ORDER: readonly ExciseGroup[] = ['LIQUOR', 'BEER', 'TIN_BEER', 'WINE'];
export const EXCISE_GROUP_LABEL: Record<ExciseGroup, string> = { LIQUOR: 'LIQUOR', BEER: 'BEER', TIN_BEER: 'TIN BEER', WINE: 'WINE' };

export interface MlFigures {
  saleUnits: number;
  saleMl: number;
  closingUnits: number;
  closingMl: number;
}

export interface MlSizeLine extends MlFigures {
  volumeMl: number;
}

export interface MlGroup extends MlFigures {
  group: ExciseGroup;
  label: string;
  bySize: MlSizeLine[];
}

export interface MlSummary {
  groups: MlGroup[];
  total: MlFigures;
  /** Liquor-center SKUs with movement or stock but no volume or excise group: left out, listed by code. */
  missing: string[];
}

const zero = (): MlFigures => ({ saleUnits: 0, saleMl: 0, closingUnits: 0, closingMl: 0 });

function add(into: MlFigures, sale: number, closing: number, ml: number): void {
  into.saleUnits += sale;
  into.saleMl += sale * ml;
  into.closingUnits += closing;
  into.closingMl += closing * ml;
}

/** `Sale` and `Closing` are the stock ledger's, so the Stock and Sales tabs show the same summary. */
export function mlSummary(rows: readonly StockLedgerRow[]): MlSummary {
  const groups = new Map<ExciseGroup, Map<number, MlSizeLine>>();
  const missing: string[] = [];
  for (const r of rows) {
    if (r.salesQty === 0 && r.closingQty === 0) continue;
    if (r.exciseGroup === null || r.volumeMl === null) {
      if (r.centerCode === 'LIQUOR') missing.push(r.skuCode);
      continue;
    }
    const sizes = groups.get(r.exciseGroup) ?? new Map<number, MlSizeLine>();
    const line = sizes.get(r.volumeMl) ?? { volumeMl: r.volumeMl, ...zero() };
    add(line, r.salesQty, r.closingQty, r.volumeMl);
    sizes.set(r.volumeMl, line);
    groups.set(r.exciseGroup, sizes);
  }
  const total = zero();
  const out: MlGroup[] = [];
  for (const group of EXCISE_GROUP_ORDER) {
    const sizes = groups.get(group);
    if (!sizes) continue;
    const bySize = [...sizes.values()].sort((a, b) => b.volumeMl - a.volumeMl);
    const figures = zero();
    for (const s of bySize) {
      figures.saleUnits += s.saleUnits;
      figures.saleMl += s.saleMl;
      figures.closingUnits += s.closingUnits;
      figures.closingMl += s.closingMl;
    }
    total.saleUnits += figures.saleUnits;
    total.saleMl += figures.saleMl;
    total.closingUnits += figures.closingUnits;
    total.closingMl += figures.closingMl;
    out.push({ group, label: EXCISE_GROUP_LABEL[group], bySize, ...figures });
  }
  return { groups: out, total, missing };
}
