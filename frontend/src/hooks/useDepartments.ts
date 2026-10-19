import { useEffect, useState } from 'react'
import { api } from '../api/client'
import type { Department } from '../api/types'

/**
 * The revenue centers (Phase 22), loaded once per mount: every active one in display order (or every
 * one, with `includeInactive`). Empty until loaded or when the server is unreachable — callers fall
 * back to readable codes.
 */
export function useDepartments(includeInactive = false): Department[] {
  const [departments, setDepartments] = useState<Department[]>([])
  useEffect(() => {
    let live = true
    api
      .listDepartments(includeInactive)
      .then((list) => {
        if (live) setDepartments(list)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [includeInactive])
  return departments
}
