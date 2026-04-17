describe('LaunchLog widget', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    document.head.innerHTML = ''
    jest.resetModules()
  })

  function loadWidget(attrs = {}) {
    jest.isolateModules(() => {
      const script = document.createElement('script')
      script.setAttribute('data-key', attrs['data-key'] || '')
      if (attrs['data-mode']) script.setAttribute('data-mode', attrs['data-mode'])
      if (attrs['data-position']) script.setAttribute('data-position', attrs['data-position'])
      Object.defineProperty(document, 'currentScript', { value: script, configurable: true })
      document.body.appendChild(script)
      require('../index.js')
    })
  }

  it('warns and exits when data-key is missing', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    loadWidget({ 'data-key': '' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Missing data-key'))
    expect(document.querySelector('button')).toBeNull()
    warn.mockRestore()
  })

  it('injects a floating button and hidden panel in floating mode', () => {
    loadWidget({ 'data-key': 'test-key-123' })
    const button = document.querySelector('button')
    expect(button).not.toBeNull()
    expect(button.getAttribute('aria-label')).toBe('Open LaunchLog')
    const panel = document.querySelector('div')
    expect(panel).not.toBeNull()
    expect(panel.style.display).toBe('none')
  })

  it('toggles panel visibility when button is clicked', () => {
    loadWidget({ 'data-key': 'test-key-123' })
    const button = document.querySelector('button')
    const panel = document.querySelector('div')
    button.click()
    expect(panel.style.display).toBe('block')
    button.click()
    expect(panel.style.display).toBe('none')
  })

  it('sets correct iframe src using project key', () => {
    loadWidget({ 'data-key': 'my-project-key' })
    const iframe = document.querySelector('iframe')
    expect(iframe.src).toContain('my-project-key')
  })

  it('injects iframe directly into parent in inline mode', () => {
    jest.isolateModules(() => {
      const container = document.createElement('div')
      const script = document.createElement('script')
      script.setAttribute('data-key', 'inline-key')
      script.setAttribute('data-mode', 'inline')
      container.appendChild(script)
      document.body.appendChild(container)
      Object.defineProperty(document, 'currentScript', { value: script, configurable: true })
      require('../index.js')
      expect(container.querySelector('iframe')).not.toBeNull()
      expect(document.querySelector('button')).toBeNull()
    })
  })
})
