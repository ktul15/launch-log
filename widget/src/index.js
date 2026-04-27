;(function () {
  var script = document.currentScript || (function () {
    var scripts = document.getElementsByTagName('script')
    return scripts[scripts.length - 1]
  })()

  var projectKey = script.getAttribute('data-key')
  var mode = script.getAttribute('data-mode') || 'floating'
  var position = script.getAttribute('data-position') || 'bottom-right'

  if (!projectKey) {
    console.warn('[LaunchLog] Missing data-key attribute on widget script tag.')
    return
  }

  // S-1: validate key format — must be UUID-safe alphanumeric + hyphens/underscores
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(projectKey)) {
    console.warn('[LaunchLog] Invalid data-key format. Expected UUID or alphanumeric key (8–64 chars).')
    return
  }

  // S-4: allowlist mode values
  if (mode !== 'floating' && mode !== 'inline') {
    console.warn('[LaunchLog] Unrecognized data-mode "' + mode + '". Defaulting to "floating".')
    mode = 'floating'
  }

  // C-3: allowlist position values
  var VALID_POSITIONS = ['bottom-right', 'bottom-left', 'top-right', 'top-left']
  if (VALID_POSITIONS.indexOf(position) === -1) {
    console.warn('[LaunchLog] Unrecognized data-position "' + position + '". Defaulting to "bottom-right".')
    position = 'bottom-right'
  }

  var WIDGET_BASE_URL = 'https://widget.launchlog.app'

  function createIframe() {
    var iframe = document.createElement('iframe')
    iframe.src = WIDGET_BASE_URL + '/' + projectKey
    iframe.style.cssText = [
      'border:none',
      'width:400px',
      'height:600px',
      'border-radius:12px',
      'box-shadow:0 4px 24px rgba(0,0,0,0.15)',
      'max-width:calc(100vw - 48px)',
    ].join(';')
    iframe.setAttribute('title', 'LaunchLog Widget')
    iframe.setAttribute('allow', 'clipboard-write')
    // S-3: sandbox prevents compromised iframe from navigating the parent page
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups')
    return iframe
  }

  if (mode === 'inline') {
    // C-1: guard detached or missing parent
    var container = script.parentElement
    if (!container) {
      console.warn('[LaunchLog] Widget script tag has no parent element.')
      return
    }
    container.appendChild(createIframe())
    return
  }

  // C-5: guard script placed in <head> without defer
  if (!document.body) {
    console.warn('[LaunchLog] Widget script must be placed before </body> or loaded with defer.')
    return
  }

  // Floating mode
  // Button: 52px, anchored at 24px from edge
  // Panel: anchored at button + edge + 12px gap
  var BUTTON_SIZE = 52
  var EDGE_OFFSET = 24
  var GAP = 12
  var PANEL_OFFSET = BUTTON_SIZE + EDGE_OFFSET + GAP  // C-4: plain number, 'px' appended below

  // C-2: split-based parsing — handles all four positions reliably
  var parts = position.split('-')
  var isBottom = parts[0] === 'bottom' || parts[1] === 'bottom'
  var isLeft = parts[0] === 'left' || parts[1] === 'left'

  var edgeProp = isBottom ? 'bottom' : 'top'
  var sideProp = isLeft ? 'left' : 'right'

  var buttonEdge = edgeProp + ':' + EDGE_OFFSET + 'px'
  var buttonSide = sideProp + ':' + EDGE_OFFSET + 'px'
  var panelEdge = edgeProp + ':' + PANEL_OFFSET + 'px'  // C-4: consistent unit construction
  var panelSide = sideProp + ':' + EDGE_OFFSET + 'px'

  var button = document.createElement('button')
  button.setAttribute('aria-label', 'Open LaunchLog')
  button.setAttribute('aria-expanded', 'false')        // C-7: expose open/closed state
  button.setAttribute('aria-controls', 'launchlog-panel')  // C-8: link button to panel
  button.style.cssText = [
    'position:fixed',
    buttonEdge,
    buttonSide,
    'z-index:9999',
    'width:' + BUTTON_SIZE + 'px',
    'height:' + BUTTON_SIZE + 'px',
    'border-radius:50%',
    'background:#4F46E5',
    'border:none',
    'cursor:pointer',
    'box-shadow:0 2px 12px rgba(0,0,0,0.2)',
  ].join(';')

  // S-2: build SVG via DOM API — immune to injection regardless of future edits
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '22')
  svg.setAttribute('height', '22')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', '#fff')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  var iconPath = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  iconPath.setAttribute('d', 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z')
  svg.appendChild(iconPath)
  button.appendChild(svg)

  var panel = document.createElement('div')
  panel.setAttribute('id', 'launchlog-panel')    // C-8
  panel.setAttribute('role', 'region')            // C-8
  panel.setAttribute('aria-label', 'LaunchLog')   // C-8
  panel.style.cssText = [
    'position:fixed',
    panelEdge,
    panelSide,
    'z-index:9998',
    'display:none',
  ].join(';')
  panel.appendChild(createIframe())

  var isOpen = false  // C-6: renamed to avoid shadowing window.open

  function openPanel() {
    isOpen = true
    panel.style.display = 'block'
    button.setAttribute('aria-expanded', 'true')  // C-7
  }

  function closePanel() {
    isOpen = false
    panel.style.display = 'none'
    button.setAttribute('aria-expanded', 'false')  // C-7
  }

  button.addEventListener('click', function (e) {
    e.stopPropagation()
    isOpen ? closePanel() : openPanel()
  })

  // C-9: Escape key closes the panel
  document.addEventListener('keydown', function (e) {
    if ((e.key === 'Escape' || e.key === 'Esc') && isOpen) {
      closePanel()
      button.focus()
    }
  })

  // C-9: click outside button+panel closes the panel
  document.addEventListener('click', function (e) {
    if (isOpen && !button.contains(e.target) && !panel.contains(e.target)) {
      closePanel()
    }
  })

  document.body.appendChild(button)
  document.body.appendChild(panel)
})()
