export interface WidgetSettings {
  showChangelog: boolean
  showRoadmap: boolean
  showFeatures: boolean
  buttonPosition: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right'
  primaryColor: string
  backgroundColor: string
}

export const DEFAULT_WIDGET_SETTINGS: WidgetSettings = {
  showChangelog: true,
  showRoadmap: true,
  showFeatures: true,
  buttonPosition: 'bottom-right',
  primaryColor: '#4f46e5',
  backgroundColor: '#ffffff',
}
