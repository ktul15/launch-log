'use client'

import { useState, useEffect, useRef } from 'react'
import { apiFetch } from '@/lib/api'
import type { WidgetSettings } from '@/types/widget'

interface Props {
  projectId: string
  projectName: string
  widgetKey: string
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

const POSITION_CLASS: Record<WidgetSettings['buttonPosition'], string> = {
  'bottom-right': 'bottom-4 right-4',
  'bottom-left': 'bottom-4 left-4',
  'top-right': 'top-4 right-4',
  'top-left': 'top-4 left-4',
}

// Issue 13: derived from POSITION_CLASS so adding a new position only requires one edit
const VALID_POSITIONS = new Set<string>(Object.keys(POSITION_CLASS))

const WIDGET_CDN_URL = 'https://cdn.launchlog.app/widget.js'
// Issue 12: same contract as widget.js and the backend schema
const WIDGET_KEY_RE = /^[a-zA-Z0-9_-]{8,64}$/
const HEX_RE = /^#[0-9a-fA-F]{6}$/

export default function WidgetSettingsClient({ projectId, projectName, widgetKey, initialSettings }: Props) {
  const [settings, setSettings] = useState<WidgetSettings>(initialSettings)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [snippetCopied, setSnippetCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  // Issue 11: store timer so it can be cancelled on unmount
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setSaved(false)
  }, [settings])

  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current)
    }
  }, [])

  const noTabsEnabled =
    !settings.showChangelog && !settings.showRoadmap && !settings.showFeatures

  // Issue 12: validate key before interpolating into snippet — corrupted key must not produce a broken/injected tag
  const validKey = WIDGET_KEY_RE.test(widgetKey)
  const snippet = validKey
    ? `<script src="${WIDGET_CDN_URL}" data-key="${widgetKey}"></script>`
    : ''

  async function handleSave() {
    // Issue 15: guard against corrupted initialSettings being round-tripped back
    if (!HEX_RE.test(settings.primaryColor) || !HEX_RE.test(settings.backgroundColor)) {
      setError('Invalid color values.')
      return
    }
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

  async function copySnippet() {
    // Issue 11: clear any in-flight timer before starting a new one
    if (copyTimer.current !== null) clearTimeout(copyTimer.current)
    try {
      await navigator.clipboard.writeText(snippet)
      setSnippetCopied(true)
      setCopyError(false)
      copyTimer.current = setTimeout(() => setSnippetCopied(false), 1500)
    } catch {
      // Issue 10: surface failure so user knows copying did not work
      setCopyError(true)
      setSnippetCopied(false)
      copyTimer.current = setTimeout(() => setCopyError(false), 2000)
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
            // Issue 9: id lets the disabled Save button reference this via aria-describedby
            <p id="no-tabs-warning" className="mt-2 text-xs text-amber-600">
              At least one tab must be enabled — the widget will show nothing otherwise.
            </p>
          )}
        </section>

        <section>
          {/* Issue 8: explicit label association for the select */}
          <label htmlFor="button-position" className="text-sm font-semibold text-gray-700 block mb-3">
            Button position
          </label>
          <select
            id="button-position"
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
              // Issue 7: explicit id+htmlFor instead of implicit label wrapping
              <div key={key} className="flex items-center gap-3">
                <label htmlFor={`color-${key}`} className="text-sm text-gray-600 w-36">
                  {label}
                </label>
                <input
                  id={`color-${key}`}
                  type="color"
                  value={settings[key]}
                  onChange={(e) => setSettings((prev) => ({ ...prev, [key]: e.target.value }))}
                  className="h-8 w-16 cursor-pointer rounded border border-gray-300 p-0.5"
                />
                <span className="text-xs font-mono text-gray-400">{settings[key]}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Issue 9: aria-describedby points to the "at least one tab" warning when it is shown */}
        <button
          onClick={handleSave}
          disabled={saving || noTabsEnabled}
          aria-describedby={noTabsEnabled ? 'no-tabs-warning' : undefined}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>

      <div className="mt-6 bg-white rounded-xl shadow-sm border border-gray-200 p-6 space-y-8">
        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-1">Embed snippet</h2>
          <p className="text-xs text-gray-500 mb-3">
            Paste this snippet before{' '}
            <code className="font-mono bg-gray-100 px-1 rounded">&lt;/body&gt;</code> on any page
            where you want the widget to appear.
          </p>
          {validKey ? (
            <div className="relative">
              <pre className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 text-xs font-mono text-gray-800 overflow-x-auto whitespace-pre-wrap break-all">
                {snippet}
              </pre>
              <button
                onClick={copySnippet}
                aria-label={snippetCopied ? 'Snippet copied' : 'Copy snippet'}
                className="absolute top-2 right-2 px-2.5 py-1 text-xs font-medium rounded bg-white border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
              >
                {/* Issue 10: show "Copy failed" when clipboard API is unavailable */}
                {snippetCopied ? 'Copied!' : copyError ? 'Copy failed' : 'Copy'}
              </button>
            </div>
          ) : (
            <p className="text-xs text-red-600">Widget key is invalid — contact support.</p>
          )}
        </section>

        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-1">Button preview</h2>
          <p className="text-xs text-gray-500 mb-3">
            Reflects your current color and position settings.
          </p>
          {/* Issue 14: role+aria-label makes the preview region meaningful to screen readers */}
          <div
            role="img"
            aria-label="Button preview reflecting current color and position settings"
            className="relative h-48 rounded-lg border border-gray-200 bg-gray-50 overflow-hidden"
          >
            <button
              aria-hidden="true"
              tabIndex={-1}
              style={{ backgroundColor: settings.primaryColor }}
              className={`absolute w-10 h-10 rounded-full border-none flex items-center justify-center shadow-md ${POSITION_CLASS[settings.buttonPosition]}`}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#fff"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}
