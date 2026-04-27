'use client'

import { useState, useEffect } from 'react'
import { apiFetch } from '@/lib/api'
import type { WidgetSettings } from '@/types/widget'

interface Props {
  projectId: string
  projectName: string
  initialSettings: WidgetSettings
}

const TAB_KEYS = [
  { key: 'showChangelog' as const, label: 'Changelog' },
  { key: 'showRoadmap' as const, label: 'Roadmap' },
  { key: 'showFeatures' as const, label: 'Features' },
]

const POSITION_OPTIONS: { value: WidgetSettings['buttonPosition']; label: string }[] = [
  { value: 'bottom-right', label: 'Bottom right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'top-right', label: 'Top right' },
  { value: 'top-left', label: 'Top left' },
]

const VALID_POSITIONS = new Set<string>(['bottom-left', 'bottom-right', 'top-left', 'top-right'])

export default function WidgetSettingsClient({ projectId, projectName, initialSettings }: Props) {
  const [settings, setSettings] = useState<WidgetSettings>(initialSettings)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setSaved(false)
  }, [settings])

  const noTabsEnabled =
    !settings.showChangelog && !settings.showRoadmap && !settings.showFeatures

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const res = await apiFetch(`/api/v1/projects/${projectId}`, {
        method: 'PATCH',
        body: JSON.stringify({ widgetSettings: settings }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError((body as Record<string, string>).message ?? 'Failed to save settings.')
        return
      }
      setSaved(true)
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-8 max-w-2xl">
      <p className="text-xs text-gray-400 mb-1">{projectName}</p>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Widget Settings</h1>

      <div role="status" aria-live="polite" aria-atomic="true">
        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}
        {saved && (
          <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
            Settings saved.
          </div>
        )}
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 space-y-8">
        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Visible tabs</h2>
          <div className="space-y-2">
            {TAB_KEYS.map(({ key, label }) => (
              <label key={key} className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings[key]}
                  onChange={(e) => setSettings((prev) => ({ ...prev, [key]: e.target.checked }))}
                  className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                />
                <span className="text-sm text-gray-700">{label}</span>
              </label>
            ))}
          </div>
          {noTabsEnabled && (
            <p className="mt-2 text-xs text-amber-600">
              At least one tab must be enabled — the widget will show nothing otherwise.
            </p>
          )}
        </section>

        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Button position</h2>
          <select
            value={settings.buttonPosition}
            onChange={(e) => {
              const val = e.target.value
              if (!VALID_POSITIONS.has(val)) return
              setSettings((prev) => ({
                ...prev,
                buttonPosition: val as WidgetSettings['buttonPosition'],
              }))
            }}
            className="block w-48 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            {POSITION_OPTIONS.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Colors</h2>
          <div className="space-y-4">
            {(
              [
                { key: 'primaryColor' as const, label: 'Primary color' },
                { key: 'backgroundColor' as const, label: 'Background color' },
              ] as const
            ).map(({ key, label }) => (
              <label key={key} className="flex items-center gap-3">
                <span className="text-sm text-gray-600 w-36">{label}</span>
                <input
                  type="color"
                  value={settings[key]}
                  onChange={(e) => setSettings((prev) => ({ ...prev, [key]: e.target.value }))}
                  className="h-8 w-16 cursor-pointer rounded border border-gray-300 p-0.5"
                />
                <span className="text-xs font-mono text-gray-400">{settings[key]}</span>
              </label>
            ))}
          </div>
        </section>

        <button
          onClick={handleSave}
          disabled={saving || noTabsEnabled}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </div>
  )
}
