'use client'

import { useState, useCallback, useMemo, useRef } from 'react'
import Link from 'next/link'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { apiFetch } from '@/lib/api'
import type { RoadmapItem, RoadmapStatus } from '@/types/roadmap'
import RoadmapItemModal from './RoadmapItemModal'

type Columns = Record<RoadmapStatus, RoadmapItem[]>

const COLUMN_LABELS: Record<RoadmapStatus, string> = {
  planned: 'Planned',
  in_progress: 'In Progress',
  shipped: 'Shipped',
}

const COLUMN_ORDER: RoadmapStatus[] = ['planned', 'in_progress', 'shipped']

const STATUS_BADGE: Record<RoadmapStatus, string> = {
  planned: 'bg-blue-50 text-blue-700',
  in_progress: 'bg-amber-50 text-amber-700',
  shipped: 'bg-green-50 text-green-700',
}

const COLUMN_HEADER: Record<RoadmapStatus, string> = {
  planned: 'bg-blue-50 border-blue-200 text-blue-800',
  in_progress: 'bg-amber-50 border-amber-200 text-amber-800',
  shipped: 'bg-green-50 border-green-200 text-green-800',
}

function groupByStatus(items: RoadmapItem[]): Columns {
  const cols: Columns = { planned: [], in_progress: [], shipped: [] }
  const sorted = [...items].sort((a, b) => a.displayOrder - b.displayOrder || a.createdAt.localeCompare(b.createdAt))
  for (const item of sorted) cols[item.status].push(item)
  return cols
}

function flattenColumns(cols: Columns): RoadmapItem[] {
  return COLUMN_ORDER.flatMap((s) => cols[s])
}

function assignDisplayOrders(cols: Columns): Array<{ id: string; displayOrder: number }> {
  return flattenColumns(cols).map((item, i) => ({ id: item.id, displayOrder: i }))
}

function findItemColumn(cols: Columns, itemId: string): RoadmapStatus | null {
  for (const status of COLUMN_ORDER) {
    if (cols[status].some((item) => item.id === itemId)) return status
  }
  return null
}

function columnsEqual(a: Columns, b: Columns): boolean {
  return COLUMN_ORDER.every(
    (s) => a[s].length === b[s].length && a[s].every((item, i) => item.id === b[s][i].id),
  )
}

interface SortableCardProps {
  item: RoadmapItem
  onEdit: (item: RoadmapItem) => void
  onDelete: (itemId: string) => void
  onStatusChange: (itemId: string, newStatus: RoadmapStatus) => void
  confirmDeleteId: string | null
  setConfirmDeleteId: (id: string | null) => void
  loadingIds: Set<string>
}

function SortableCard({ item, onEdit, onDelete, onStatusChange, confirmDeleteId, setConfirmDeleteId, loadingIds }: SortableCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  const isConfirming = confirmDeleteId === item.id
  const isLoading = loadingIds.has(item.id)

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="bg-white rounded-lg border border-gray-200 shadow-sm p-3 cursor-grab active:cursor-grabbing select-none"
      {...attributes}
      {...listeners}
    >
      <p className="text-sm font-medium text-gray-900 leading-snug mb-1">{item.title}</p>
      {item.description && (
        <p className="text-xs text-gray-500 leading-relaxed line-clamp-2 mb-2">{item.description}</p>
      )}
      <div
        className="flex items-center justify-between gap-2 pt-1"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <select
          value={item.status}
          onChange={(e) => {
            const s = e.target.value as RoadmapStatus
            if (COLUMN_ORDER.includes(s)) onStatusChange(item.id, s)
          }}
          disabled={isLoading}
          className="text-xs px-1.5 py-0.5 rounded border border-gray-200 bg-gray-50 text-gray-600 cursor-pointer disabled:opacity-50 focus:outline-none focus:border-indigo-300"
        >
          <option value="planned">Planned</option>
          <option value="in_progress">In Progress</option>
          <option value="shipped">Shipped</option>
        </select>
        <div className="flex items-center gap-2">
          {isConfirming ? (
            <>
              <button
                onClick={() => onDelete(item.id)}
                disabled={isLoading}
                className="text-xs text-red-600 hover:text-red-800 font-medium disabled:opacity-50"
              >
                {isLoading ? 'Deleting…' : 'Confirm'}
              </button>
              <button
                onClick={() => setConfirmDeleteId(null)}
                className="text-xs text-gray-500 hover:text-gray-700"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => onEdit(item)}
                className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
              >
                Edit
              </button>
              <button
                onClick={() => setConfirmDeleteId(item.id)}
                disabled={isLoading}
                className="text-xs text-red-500 hover:text-red-700 font-medium disabled:opacity-50"
              >
                Delete
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function DragCard({ item }: { item: RoadmapItem }) {
  return (
    <div className="bg-white rounded-lg border border-indigo-300 shadow-lg p-3 w-64 opacity-95">
      <p className="text-sm font-medium text-gray-900">{item.title}</p>
      {item.description && (
        <p className="text-xs text-gray-500 line-clamp-2 mt-1">{item.description}</p>
      )}
    </div>
  )
}

interface Props {
  projectId: string
  projectName: string
  initialItems: RoadmapItem[]
}

export default function RoadmapClient({ projectId, projectName, initialItems }: Props) {
  const [columns, setColumns] = useState<Columns>(() => groupByStatus(initialItems))
  const [activeItem, setActiveItem] = useState<RoadmapItem | null>(null)
  const [dragOverColumn, setDragOverColumn] = useState<RoadmapStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set())
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [modal, setModal] = useState<
    | { mode: 'create'; status: RoadmapStatus }
    | { mode: 'edit'; item: RoadmapItem }
    | null
  >(null)

  // Always-fresh ref — reads latest columns without stale closure in async handlers
  const columnsRef = useRef<Columns>(columns)
  columnsRef.current = columns

  // Prevents concurrent drags/saves while a save is in flight
  const isSavingRef = useRef(false)

  // Sync mirror of loadingIds for reads inside async handlers (state reads are stale)
  const loadingIdsRef = useRef<Set<string>>(new Set())

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  )

  const addLoading = useCallback((id: string) => {
    loadingIdsRef.current.add(id)
    setLoadingIds((prev) => new Set(prev).add(id))
  }, [])

  const removeLoading = useCallback((id: string) => {
    loadingIdsRef.current.delete(id)
    setLoadingIds((prev) => { const n = new Set(prev); n.delete(id); return n })
  }, [])

  // Functional revert — moves itemId back to sourceCol without overwriting concurrent changes
  function revertItem(itemId: string, sourceCol: RoadmapStatus) {
    setColumns((prev) => {
      const next: Columns = { planned: [...prev.planned], in_progress: [...prev.in_progress], shipped: [...prev.shipped] }
      for (const s of COLUMN_ORDER) {
        const idx = next[s].findIndex((i) => i.id === itemId)
        if (idx !== -1) {
          const [moved] = next[s].splice(idx, 1)
          next[sourceCol].push({ ...moved, status: sourceCol })
          break
        }
      }
      return next
    })
  }

  const handleDragStart = useCallback(({ active }: DragStartEvent) => {
    for (const status of COLUMN_ORDER) {
      const found = columnsRef.current[status].find((i) => i.id === active.id)
      if (found) { setActiveItem(found); break }
    }
  }, [])

  const handleDragOver = useCallback(({ over }: DragOverEvent) => {
    if (!over) { setDragOverColumn(null); return }
    const overId = String(over.id)
    if (COLUMN_ORDER.includes(overId as RoadmapStatus)) {
      setDragOverColumn(overId as RoadmapStatus)
    } else {
      setDragOverColumn(findItemColumn(columnsRef.current, overId))
    }
  }, [])

  const handleDragEnd = useCallback(async ({ active, over }: DragEndEvent) => {
    setActiveItem(null)
    setDragOverColumn(null)
    if (!over || isSavingRef.current) return

    const activeId = String(active.id)
    const overId = String(over.id)

    // Read latest state from ref — no stale closure
    const currentColumns = columnsRef.current
    const sourceCol = findItemColumn(currentColumns, activeId)
    if (!sourceCol) return

    const destCol: RoadmapStatus = COLUMN_ORDER.includes(overId as RoadmapStatus)
      ? (overId as RoadmapStatus)
      : (findItemColumn(currentColumns, overId) ?? sourceCol)

    // Compute new column state synchronously — no async state-read tricks
    const nextCols: Columns = {
      planned: [...currentColumns.planned],
      in_progress: [...currentColumns.in_progress],
      shipped: [...currentColumns.shipped],
    }

    const srcList = nextCols[sourceCol]
    const srcIdx = srcList.findIndex((i) => i.id === activeId)
    if (srcIdx === -1) return
    const [moved] = srcList.splice(srcIdx, 1)

    const dstList = nextCols[destCol]
    const dstIdx = COLUMN_ORDER.includes(overId as RoadmapStatus)
      ? dstList.length
      : dstList.findIndex((i) => i.id === overId)
    dstList.splice(dstIdx === -1 ? dstList.length : dstIdx, 0, { ...moved, status: destCol })

    if (columnsEqual(currentColumns, nextCols)) return

    setColumns(nextCols)
    setError(null)
    isSavingRef.current = true
    setIsSaving(true)

    try {
      if (sourceCol !== destCol) {
        const res = await apiFetch(`/api/v1/projects/${projectId}/roadmap/${activeId}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: destCol }),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          setError((body as { message?: string }).message ?? 'Failed to update status.')
          setColumns(currentColumns)
          return
        }
      }

      const reorderItems = assignDisplayOrders(nextCols)
      const res = await apiFetch(`/api/v1/projects/${projectId}/roadmap/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ items: reorderItems }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError((body as { message?: string }).message ?? 'Failed to save order.')
        setColumns(currentColumns)
      }
    } catch {
      setError('Network error. Order not saved.')
      setColumns(currentColumns)
    } finally {
      isSavingRef.current = false
      setIsSaving(false)
    }
  }, [projectId])

  async function handleDelete(itemId: string) {
    addLoading(itemId)
    setError(null)
    try {
      const res = await apiFetch(`/api/v1/projects/${projectId}/roadmap/${itemId}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError((body as { message?: string }).message ?? 'Failed to delete item.')
        return
      }
      setColumns((prev) => {
        const next: Columns = { planned: [...prev.planned], in_progress: [...prev.in_progress], shipped: [...prev.shipped] }
        for (const s of COLUMN_ORDER) next[s] = next[s].filter((i) => i.id !== itemId)
        return next
      })
      setConfirmDeleteId(null)
    } finally {
      removeLoading(itemId)
    }
  }

  async function handleStatusChange(itemId: string, newStatus: RoadmapStatus) {
    // Block if drag save in flight (2.2) or this item already has an op in flight (2.1, 2.3)
    if (isSavingRef.current || loadingIdsRef.current.has(itemId)) return

    const currentColumns = columnsRef.current
    const sourceCol = findItemColumn(currentColumns, itemId)
    if (!sourceCol || sourceCol === newStatus) return

    const item = currentColumns[sourceCol].find((i) => i.id === itemId)
    if (!item) return  // 1.2: guard against deleted item

    // Compute next state synchronously so reorder payload is stable (6.2)
    const nextCols: Columns = {
      planned: [...currentColumns.planned],
      in_progress: [...currentColumns.in_progress],
      shipped: [...currentColumns.shipped],
    }
    nextCols[sourceCol] = nextCols[sourceCol].filter((i) => i.id !== itemId)
    nextCols[newStatus] = [...nextCols[newStatus], { ...item, status: newStatus }]

    addLoading(itemId)
    setError(null)
    isSavingRef.current = true   // 2.2: explicit guard blocks concurrent drags
    setIsSaving(true)            // 4.1: show Saving… indicator
    setColumns(nextCols)

    try {
      const statusRes = await apiFetch(`/api/v1/projects/${projectId}/roadmap/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus }),
      })
      if (!statusRes.ok) {
        const body = await statusRes.json().catch(() => ({}))
        setError((body as { message?: string }).message ?? 'Failed to update status.')
        revertItem(itemId, sourceCol)  // 1.1: functional revert preserves concurrent changes
        return
      }

      // Sync displayOrder to DB so reload positions are correct (6.2)
      const reorderRes = await apiFetch(`/api/v1/projects/${projectId}/roadmap/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ items: assignDisplayOrders(nextCols) }),
      })
      if (!reorderRes.ok) {
        const body = await reorderRes.json().catch(() => ({}))
        setError((body as { message?: string }).message ?? 'Failed to save order.')
        revertItem(itemId, sourceCol)  // 1.1
      }
    } catch {
      setError('Network error. Status not updated.')
      revertItem(itemId, sourceCol)  // 1.1
    } finally {
      removeLoading(itemId)
      isSavingRef.current = false
      setIsSaving(false)
    }
  }

  function handleModalSave(saved: RoadmapItem) {
    // Capture modal state before any batched state updates run
    const isEdit = modal?.mode === 'edit'
    const editedId = modal?.mode === 'edit' ? modal.item.id : null

    setColumns((prev) => {
      const next: Columns = { planned: [...prev.planned], in_progress: [...prev.in_progress], shipped: [...prev.shipped] }
      if (isEdit && editedId) {
        for (const s of COLUMN_ORDER) {
          const idx = next[s].findIndex((i) => i.id === editedId)
          if (idx !== -1) {
            if (s === saved.status) { next[s][idx] = saved }
            else { next[s].splice(idx, 1); next[saved.status].push(saved) }
            break
          }
        }
      } else {
        next[saved.status].push(saved)
      }
      return next
    })
    setModal(null)
  }

  const totalItems = useMemo(() => flattenColumns(columns).length, [columns])

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <Link href="/dashboard/projects" className="text-gray-400 hover:text-gray-600 transition-colors">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </Link>
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wide font-medium">{projectName}</p>
              <h1 className="text-2xl font-bold text-gray-900">Roadmap</h1>
            </div>
          </div>
          {isSaving && (
            <span className="text-xs text-gray-400 animate-pulse">Saving…</span>
          )}
        </div>

        {error && (
          <div className="mb-6 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700 flex items-center justify-between">
            <span>{error}</span>
            <button
              onClick={() => setError(null)}
              aria-label="Dismiss error"
              className="ml-3 text-red-400 hover:text-red-600 transition-colors"
            >
              ✕
            </button>
          </div>
        )}

        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          <div className={`grid grid-cols-3 gap-5 transition-opacity ${isSaving ? 'opacity-60 pointer-events-none' : ''}`}>
            {COLUMN_ORDER.map((status) => {
              const items = columns[status]
              const isOver = dragOverColumn === status
              return (
                <div
                  key={status}
                  id={status}
                  className={`flex flex-col rounded-xl border-2 transition-colors ${
                    isOver ? 'border-indigo-300 bg-indigo-50/30' : 'border-transparent bg-gray-100'
                  }`}
                >
                  <div className={`flex items-center justify-between px-4 py-3 rounded-t-xl border ${COLUMN_HEADER[status]}`}>
                    <span className="text-sm font-semibold">{COLUMN_LABELS[status]}</span>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_BADGE[status]}`}>
                      {items.length}
                    </span>
                  </div>

                  <div className="flex-1 p-3 space-y-2 min-h-[120px]">
                    <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
                      {items.map((item) => (
                        <SortableCard
                          key={item.id}
                          item={item}
                          onEdit={(i) => setModal({ mode: 'edit', item: i })}
                          onDelete={handleDelete}
                          onStatusChange={handleStatusChange}
                          confirmDeleteId={confirmDeleteId}
                          setConfirmDeleteId={setConfirmDeleteId}
                          loadingIds={loadingIds}
                        />
                      ))}
                    </SortableContext>
                  </div>

                  <div className="px-3 pb-3">
                    <button
                      onClick={() => setModal({ mode: 'create', status })}
                      className="w-full py-2 text-sm text-gray-500 hover:text-indigo-600 hover:bg-white rounded-lg border border-dashed border-gray-300 hover:border-indigo-300 transition-colors"
                    >
                      + Add item
                    </button>
                  </div>
                </div>
              )
            })}
          </div>

          <DragOverlay>
            {activeItem ? <DragCard item={activeItem} /> : null}
          </DragOverlay>
        </DndContext>

        {totalItems === 0 && !isSaving && (
          <p className="text-center text-gray-400 text-sm mt-6">No roadmap items yet. Use + Add item in any column.</p>
        )}
      </div>

      {modal?.mode === 'create' && (
        <RoadmapItemModal
          projectId={projectId}
          mode="create"
          initialStatus={modal.status}
          onSave={handleModalSave}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.mode === 'edit' && (
        <RoadmapItemModal
          projectId={projectId}
          mode="edit"
          item={modal.item}
          onSave={handleModalSave}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  )
}
