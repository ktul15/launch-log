import { DEFAULT_WIDGET_SETTINGS } from '@/types/widget'
import type { WidgetSettings } from '@/types/widget'

const VALID_POSITIONS = new Set<string>(['bottom-left', 'bottom-right', 'top-left', 'top-right'])
const HEX_RE = /^#[0-9a-fA-F]{6}$/

/**
 * Parses an unknown DB/API value into a complete WidgetSettings object.
 * Falls back field-by-field to defaults so partial stored objects (e.g. the
 * Prisma empty-object default "{}") are handled gracefully. Adding a new field
 * to WidgetSettings requires updating widgetSettingsSchema in projects.ts in
 * the same change — they must stay in sync.
 */
export function parseWidgetSettings(raw: unknown): WidgetSettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_WIDGET_SETTINGS }
  const s = raw as Record<string, unknown>
  return {
    showChangelog:
      typeof s.showChangelog === 'boolean' ? s.showChangelog : DEFAULT_WIDGET_SETTINGS.showChangelog,
    showRoadmap:
      typeof s.showRoadmap === 'boolean' ? s.showRoadmap : DEFAULT_WIDGET_SETTINGS.showRoadmap,
    showFeatures:
      typeof s.showFeatures === 'boolean' ? s.showFeatures : DEFAULT_WIDGET_SETTINGS.showFeatures,
    buttonPosition: VALID_POSITIONS.has(s.buttonPosition as string)
      ? (s.buttonPosition as WidgetSettings['buttonPosition'])
      : DEFAULT_WIDGET_SETTINGS.buttonPosition,
    primaryColor:
      typeof s.primaryColor === 'string' && HEX_RE.test(s.primaryColor)
        ? s.primaryColor
        : DEFAULT_WIDGET_SETTINGS.primaryColor,
    backgroundColor:
      typeof s.backgroundColor === 'string' && HEX_RE.test(s.backgroundColor)
        ? s.backgroundColor
        : DEFAULT_WIDGET_SETTINGS.backgroundColor,
  }
}
