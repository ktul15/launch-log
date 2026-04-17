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

  var WIDGET_BASE_URL = 'https://widget.launchlog.app'

  function createIframe() {
    var iframe = document.createElement('iframe')
    iframe.src = WIDGET_BASE_URL + '/' + projectKey
    iframe.style.cssText = [
      'border: none',
      'width: 400px',
      'height: 600px',
      'border-radius: 12px',
      'box-shadow: 0 4px 24px rgba(0,0,0,0.15)',
    ].join(';')
    iframe.setAttribute('title', 'LaunchLog Widget')
    iframe.setAttribute('allow', 'clipboard-write')
    return iframe
  }

  if (mode === 'inline') {
    var container = script.parentElement
    container.appendChild(createIframe())
    return
  }

  // Floating mode
  // Button: 52px height, anchored at 24px from edge
  // Panel: anchored at (52 + 24 + 12)px = 88px from edge so it clears the button with a 12px gap
  var BUTTON_SIZE = 52
  var EDGE_OFFSET = 24
  var GAP = 12
  var PANEL_OFFSET = BUTTON_SIZE + EDGE_OFFSET + GAP + 'px'

  var isBottom = position.indexOf('bottom') === 0
  var isLeft = position.indexOf('left', position.indexOf('-') + 1) !== -1

  var buttonEdge = (isBottom ? 'bottom' : 'top') + ':' + EDGE_OFFSET + 'px'
  var buttonSide = (isLeft ? 'left' : 'right') + ':' + EDGE_OFFSET + 'px'
  var panelEdge = (isBottom ? 'bottom' : 'top') + ':' + PANEL_OFFSET
  var panelSide = (isLeft ? 'left' : 'right') + ':' + EDGE_OFFSET + 'px'

  var button = document.createElement('button')
  button.setAttribute('aria-label', 'Open LaunchLog')
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
  button.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>'

  var panel = document.createElement('div')
  panel.style.cssText = [
    'position:fixed',
    panelEdge,
    panelSide,
    'z-index:9998',
    'display:none',
  ].join(';')
  panel.appendChild(createIframe())

  var open = false
  button.addEventListener('click', function () {
    open = !open
    panel.style.display = open ? 'block' : 'none'
  })

  document.body.appendChild(button)
  document.body.appendChild(panel)
})()
