import type { Department, DepartmentStation } from '../../api/types'
import { Modal } from '../../billing/Modal'
import { MAX_CENTER_NAME, STATION_LABEL, type CenterForm } from '../../centers/centerForm'
import { FOCUS_RING } from '../../lib/ui'
import { Toggle } from '../settings/SettingsControls'

const STATIONS: DepartmentStation[] = ['BAR', 'KITCHEN', 'NONE']
const STATION_HINT: Record<DepartmentStation, string> = {
  BAR: 'KOT prints at the bar (cigarettes, water, cool drinks)',
  KITCHEN: 'KOT prints in the kitchen',
  NONE: 'No ticket — a service such as AC charges',
}

/**
 * Touch-friendly add / edit modal for a revenue center (Phase 22): name, where its KOT prints, whether
 * its items are stock-tracked, and (when editing) active. Liquor's behaviour is locked.
 */
export function CenterModal({
  form,
  original,
  error,
  showError,
  saving,
  onEdit,
  onSave,
  onClose,
}: {
  form: CenterForm
  original: Department | undefined
  error: string | null
  /** The server refused the last save: outline the field. */
  showError: boolean
  saving: boolean
  onEdit: (patch: Partial<CenterForm>) => void
  onSave: () => void
  onClose: () => void
}) {
  const locked = original?.code === 'LIQUOR'
  const disabling = original?.isActive === true && !form.isActive
  return (
    <Modal
      title={original ? `Edit ${original.name}` : 'New revenue center'}
      onClose={onClose}
      onKey={(e) => {
        if (e.key === 'Enter' || e.key === 'F9') {
          onSave()
          return true
        }
        return false
      }}
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className={`text-sm ${error ? 'text-amber-300' : 'text-zinc-400'}`}>{error ?? 'Enter or F9 saves · Esc cancels'}</span>
          <button
            type="button"
            onClick={onSave}
            disabled={saving || error !== null}
            className={`enabled:hover:brightness-110 min-h-12 rounded-lg px-6 text-lg font-black text-zinc-950 disabled:opacity-50 ${disabling ? 'bg-rose-500' : 'bg-emerald-500'}`}
          >
            {saving ? 'Saving…' : disabling ? 'Disable & save' : original ? 'Save' : 'Add center'}
          </button>
        </div>
      }
    >
      <label className="block">
        <span className="text-sm font-semibold text-zinc-300">Name</span>
        <input
          data-autofocus
          value={form.name}
          maxLength={MAX_CENTER_NAME + 10}
          autoComplete="off"
          onChange={(e) => onEdit({ name: e.target.value })}
          placeholder="e.g. Cigarettes, Paan, AC Charges"
          className={`mt-1 w-full rounded-md border-2 bg-zinc-950 px-4 py-4 text-2xl outline-none focus:border-amber-400 ${showError ? 'border-rose-500' : 'border-zinc-600'}`}
        />
      </label>
      {original && <p className="mt-1 text-sm text-zinc-500">Code {original.code} — fixed, so past bills keep pointing at it.</p>}
      <div className="mt-4">
        <span className="text-sm font-semibold text-zinc-300">KOT ticket</span>
        <div className="mt-1 grid grid-cols-3 gap-2" role="radiogroup" aria-label="KOT ticket">
          {STATIONS.map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={form.kotStation === s}
              disabled={locked}
              onClick={() => onEdit({ kotStation: s })}
              className={`min-h-14 rounded-lg border-2 px-3 text-left disabled:opacity-50 ${form.kotStation === s ? 'border-teal-400 bg-teal-400 text-zinc-950' : 'border-zinc-700 bg-zinc-950 text-zinc-300'} ${FOCUS_RING}`}
            >
              <span className="block text-lg font-black">{STATION_LABEL[s]}</span>
              <span className="block text-xs opacity-80">{STATION_HINT[s]}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <Toggle
          on={form.tracksStock}
          onClick={() => !locked && onEdit({ tracksStock: !form.tracksStock })}
          title={form.tracksStock ? 'Stock tracked' : 'No stock'}
          hint={form.tracksStock ? 'Counted units, received through Purchase (GRN)' : 'Sold without stock (dishes, services)'}
        />
        {original && !locked && (
          <Toggle on={form.isActive} onClick={() => onEdit({ isActive: !form.isActive })} title={form.isActive ? 'Active' : 'Disabled'} hint="Offered in the catalog and Revenue Centers" />
        )}
      </div>
      {locked && <p className="mt-3 text-sm text-zinc-400">Liquor is the core business: only its name can change.</p>}
      {disabling && <p className="mt-3 rounded-md border-l-4 border-rose-500 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">Hidden from pickers and Revenue Centers; its history stays.</p>}
    </Modal>
  )
}
