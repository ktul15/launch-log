describe('LaunchLog widget', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    document.head.innerHTML = ''
    jest.resetModules()
  })

  function loadWidget(attrs = {}) {
    jest.isolateModules(() => {
      const script = document.createElement('script')
      if ('data-key' in attrs) script.setAttribute('data-key', attrs['data-key'])
      if (attrs['data-mode']) script.setAttribute('data-mode', attrs['data-mode'])
      if (attrs['data-position']) script.setAttribute('data-position', attrs['data-position'])
      Object.defineProperty(document, 'currentScript', { value: script, configurable: true })
      document.body.appendChild(script)
      require('../index.js')
    })
  }

  // --- key validation ---

  it('warns and exits when data-key is empty string', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    loadWidget({ 'data-key': '' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Missing data-key'))
    expect(document.querySelector('button')).toBeNull()
    warn.mockRestore()
  })

  it('warns and exits when data-key attribute is absent (null)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    loadWidget({})  // no 'data-key' key — getAttribute returns null
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Missing data-key'))
    expect(document.querySelector('button')).toBeNull()
    warn.mockRestore()
  })

  it('warns and exits when data-key fails format validation (path-traversal)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    loadWidget({ 'data-key': '../../admin' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Invalid data-key'))
    expect(document.querySelector('button')).toBeNull()
    warn.mockRestore()
  })

  // --- mode validation ---

  it('warns and falls back to floating when data-mode is unrecognized', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    loadWidget({ 'data-key': 'test-key-1234', 'data-mode': 'modla' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Unrecognized data-mode'))
    expect(document.querySelector('button')).not.toBeNull()
    warn.mockRestore()
  })

  // --- position validation ---

  it('warns and falls back to bottom-right when data-position is unrecognized', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    loadWidget({ 'data-key': 'test-key-1234', 'data-position': 'middle-center' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Unrecognized data-position'))
    expect(document.querySelector('button')).not.toBeNull()
    warn.mockRestore()
  })

  // --- floating mode ---

  it('injects a floating button and hidden panel in floating mode', () => {
    loadWidget({ 'data-key': 'test-key-1234' })
    const button = document.querySelector('button')
    expect(button).not.toBeNull()
    expect(button.getAttribute('aria-label')).toBe('Open LaunchLog')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    const panel = document.querySelector('div')
    expect(panel).not.toBeNull()
    expect(panel.style.display).toBe('none')
  })

  it('toggles panel visibility and aria-expanded when button is clicked', () => {
    loadWidget({ 'data-key': 'test-key-1234' })
    const button = document.querySelector('button')
    const panel = document.querySelector('div')
    button.click()
    expect(panel.style.display).toBe('block')
    expect(button.getAttribute('aria-expanded')).toBe('true')
    button.click()
    expect(panel.style.display).toBe('none')
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('closes panel on Escape key', () => {
    loadWidget({ 'data-key': 'test-key-1234' })
    const button = document.querySelector('button')
    const panel = document.querySelector('div')
    button.click()
    expect(panel.style.display).toBe('block')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(panel.style.display).toBe('none')
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('closes panel on outside click', () => {
    loadWidget({ 'data-key': 'test-key-1234' })
    const button = document.querySelector('button')
    const panel = document.querySelector('div')
    button.click()
    expect(panel.style.display).toBe('block')
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(panel.style.display).toBe('none')
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('warns and exits in floating mode when document.body is null', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    jest.isolateModules(() => {
      const script = document.createElement('script')
      script.setAttribute('data-key', 'test-key-1234')
      Object.defineProperty(document, 'currentScript', { value: script, configurable: true })
      const savedBody = document.body
      Object.defineProperty(document, 'body', { value: null, configurable: true })
      try {
        require('../index.js')
      } finally {
        Object.defineProperty(document, 'body', { value: savedBody, configurable: true })
      }
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('before </body>'))
    warn.mockRestore()
  })

  // --- iframe ---

  it('sets correct iframe src using project key', () => {
    loadWidget({ 'data-key': 'my-project-key' })
    const iframe = document.querySelector('iframe')
    expect(iframe.src).toBe('https://widget.launchlog.app/my-project-key')
  })

  it('iframe has sandbox attribute with required permissions', () => {
    loadWidget({ 'data-key': 'test-key-1234' })
    const iframe = document.querySelector('iframe')
    const sandbox = iframe.getAttribute('sandbox')
    expect(sandbox).toContain('allow-scripts')
    expect(sandbox).toContain('allow-same-origin')
  })

  // --- inline mode ---

  it('injects iframe directly into parent in inline mode', () => {
    jest.isolateModules(() => {
      const container = document.createElement('div')
      const script = document.createElement('script')
      script.setAttribute('data-key', 'inline-key-1234')
      script.setAttribute('data-mode', 'inline')
      container.appendChild(script)
      document.body.appendChild(container)
      Object.defineProperty(document, 'currentScript', { value: script, configurable: true })
      require('../index.js')
      expect(container.querySelector('iframe')).not.toBeNull()
      expect(document.querySelector('button')).toBeNull()
    })
  })

  it('warns and exits in inline mode when script has no parent element', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    jest.isolateModules(() => {
      const script = document.createElement('script')
      script.setAttribute('data-key', 'inline-key-1234')
      script.setAttribute('data-mode', 'inline')
      // detached script — parentElement is null
      Object.defineProperty(document, 'currentScript', { value: script, configurable: true })
      require('../index.js')
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no parent element'))
    warn.mockRestore()
  })

  // --- position variants ---

  it('positions button bottom-left when data-position is bottom-left', () => {
    loadWidget({ 'data-key': 'pos-key-12345', 'data-position': 'bottom-left' })
    const button = document.querySelector('button')
    expect(button.style.cssText).toContain('left: 24px')
    expect(button.style.cssText).toContain('bottom: 24px')
  })

  it('positions button top-right when data-position is top-right', () => {
    loadWidget({ 'data-key': 'pos-key-12345', 'data-position': 'top-right' })
    const button = document.querySelector('button')
    expect(button.style.cssText).toContain('right: 24px')
    expect(button.style.cssText).toContain('top: 24px')
  })

  it('positions button top-left when data-position is top-left', () => {
    loadWidget({ 'data-key': 'pos-key-12345', 'data-position': 'top-left' })
    const button = document.querySelector('button')
    expect(button.style.cssText).toContain('left: 24px')
    expect(button.style.cssText).toContain('top: 24px')
  })
})
