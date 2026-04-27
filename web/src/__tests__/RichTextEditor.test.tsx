import { render, screen, fireEvent } from '@testing-library/react'
import RichTextEditor from '@/components/RichTextEditor'
import type { TipTapDoc } from '@/types/changelog'

const mockGetJSON = jest.fn(() => ({ type: 'doc', content: [] }))
const mockChain = jest.fn()

const mockEditor = {
  isActive: jest.fn(() => false),
  getJSON: mockGetJSON,
  chain: mockChain,
  state: { selection: { empty: true } },
}

let onUpdateCallback: ((args: { editor: typeof mockEditor }) => void) | null = null

jest.mock('@tiptap/react', () => ({
  __esModule: true,
  useEditor: jest.fn((config) => {
    onUpdateCallback = config.onUpdate ?? null
    return mockEditor
  }),
  EditorContent: ({ editor }: { editor: unknown }) =>
    editor ? <div data-testid="editor-content" /> : null,
}))

jest.mock('@tiptap/starter-kit', () => ({ __esModule: true, default: {} }))
jest.mock('@tiptap/extension-underline', () => ({ __esModule: true, default: {} }))
jest.mock('@tiptap/extension-link', () => ({
  __esModule: true,
  default: { configure: () => ({}) },
}))
jest.mock('@tiptap/extension-image', () => ({ __esModule: true, default: {} }))

beforeEach(() => {
  jest.clearAllMocks()
  mockChain.mockReturnValue({
    focus: jest.fn().mockReturnThis(),
    toggleBold: jest.fn().mockReturnThis(),
    toggleItalic: jest.fn().mockReturnThis(),
    toggleUnderline: jest.fn().mockReturnThis(),
    toggleHeading: jest.fn().mockReturnThis(),
    toggleBulletList: jest.fn().mockReturnThis(),
    toggleOrderedList: jest.fn().mockReturnThis(),
    toggleCodeBlock: jest.fn().mockReturnThis(),
    toggleLink: jest.fn().mockReturnThis(),
    setLink: jest.fn().mockReturnThis(),
    setImage: jest.fn().mockReturnThis(),
    insertContent: jest.fn().mockReturnThis(),
    run: jest.fn(),
  })
})

const CONTENT: TipTapDoc = { type: 'doc', content: [] }

describe('RichTextEditor', () => {
  it('renders toolbar buttons', () => {
    render(<RichTextEditor content={CONTENT} onChange={jest.fn()} />)
    expect(screen.getByTitle('Bold')).toBeInTheDocument()
    expect(screen.getByTitle('Italic')).toBeInTheDocument()
    expect(screen.getByTitle('Underline')).toBeInTheDocument()
    expect(screen.getByTitle('Heading 2')).toBeInTheDocument()
    expect(screen.getByTitle('Heading 3')).toBeInTheDocument()
    expect(screen.getByTitle('Bullet list')).toBeInTheDocument()
    expect(screen.getByTitle('Ordered list')).toBeInTheDocument()
    expect(screen.getByTitle('Code block')).toBeInTheDocument()
    expect(screen.getByTitle('Link')).toBeInTheDocument()
    expect(screen.getByTitle('Image')).toBeInTheDocument()
  })

  it('hides toolbar when editable=false', () => {
    render(<RichTextEditor content={CONTENT} onChange={jest.fn()} editable={false} />)
    expect(screen.queryByTitle('Bold')).not.toBeInTheDocument()
  })

  it('renders editor content area', () => {
    render(<RichTextEditor content={CONTENT} onChange={jest.fn()} />)
    expect(screen.getByTestId('editor-content')).toBeInTheDocument()
  })

  it('calls onChange when editor updates', () => {
    const onChange = jest.fn()
    render(<RichTextEditor content={CONTENT} onChange={onChange} />)
    onUpdateCallback?.({ editor: mockEditor })
    expect(onChange).toHaveBeenCalledWith({ type: 'doc', content: [] })
  })

  it('toggles bold on Bold button click', () => {
    render(<RichTextEditor content={CONTENT} onChange={jest.fn()} />)
    fireEvent.mouseDown(screen.getByTitle('Bold'))
    expect(mockChain).toHaveBeenCalled()
  })

  it('prompts for URL on Link button click', () => {
    window.prompt = jest.fn(() => 'https://example.com')
    render(<RichTextEditor content={CONTENT} onChange={jest.fn()} />)
    fireEvent.mouseDown(screen.getByTitle('Link'))
    expect(window.prompt).toHaveBeenCalledWith('URL')
  })

  it('inserts URL as linked text when selection is empty', () => {
    window.prompt = jest.fn(() => 'https://example.com')
    render(<RichTextEditor content={CONTENT} onChange={jest.fn()} />)
    fireEvent.mouseDown(screen.getByTitle('Link'))
    const chain = mockChain.mock.results[0].value
    expect(chain.insertContent).toHaveBeenCalledWith({
      type: 'text',
      text: 'https://example.com',
      marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
    })
  })

  it('prompts for URL on Image button click when no projectId', () => {
    window.prompt = jest.fn(() => 'https://example.com/img.png')
    render(<RichTextEditor content={CONTENT} onChange={jest.fn()} />)
    fireEvent.mouseDown(screen.getByTitle('Image'))
    expect(window.prompt).toHaveBeenCalledWith('Image URL')
  })

  it('rejects javascript: URL for Link and shows alert', () => {
    window.prompt = jest.fn(() => 'javascript:alert(document.cookie)')
    window.alert = jest.fn()
    render(<RichTextEditor content={CONTENT} onChange={jest.fn()} />)
    fireEvent.mouseDown(screen.getByTitle('Link'))
    expect(window.alert).toHaveBeenCalledWith('Only http:// and https:// URLs are allowed.')
    expect(mockChain).not.toHaveBeenCalled()
  })

  it('rejects javascript: URL for Image and shows alert when no projectId', () => {
    window.prompt = jest.fn(() => 'javascript:alert(1)')
    window.alert = jest.fn()
    render(<RichTextEditor content={CONTENT} onChange={jest.fn()} />)
    fireEvent.mouseDown(screen.getByTitle('Image'))
    expect(window.alert).toHaveBeenCalledWith('Only http:// and https:// URLs are allowed.')
    expect(mockChain).not.toHaveBeenCalled()
  })

  it('does not call prompt when projectId provided — uses file input instead', () => {
    window.prompt = jest.fn()
    render(<RichTextEditor content={CONTENT} onChange={jest.fn()} projectId="proj-1" />)
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const clickSpy = jest.spyOn(fileInput, 'click').mockImplementation(() => {})
    fireEvent.mouseDown(screen.getByTitle('Image'))
    expect(window.prompt).not.toHaveBeenCalled()
    expect(clickSpy).toHaveBeenCalled()
  })

  it('rejects disallowed MIME type via file input', async () => {
    window.alert = jest.fn()
    render(<RichTextEditor content={CONTENT} onChange={jest.fn()} projectId="proj-1" />)
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['x'], 'doc.pdf', { type: 'application/pdf' })
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true })
    fireEvent.change(fileInput)
    expect(window.alert).toHaveBeenCalledWith('Allowed image types: JPEG, PNG, GIF, WebP.')
  })

  it('rejects file over 5MB via file input', async () => {
    window.alert = jest.fn()
    render(<RichTextEditor content={CONTENT} onChange={jest.fn()} projectId="proj-1" />)
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const bigContent = new Uint8Array(6 * 1024 * 1024)
    const file = new File([bigContent], 'big.jpg', { type: 'image/jpeg' })
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true })
    fireEvent.change(fileInput)
    expect(window.alert).toHaveBeenCalledWith('Image must be 5 MB or smaller.')
  })

  it('fetches presigned URL and uploads file on valid image', async () => {
    const publicUrl = 'https://cdn.example.com/projects/proj-1/images/123.jpg'
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ uploadUrl: 'https://r2.example.com/upload', publicUrl }),
      } as Response)
      .mockResolvedValueOnce({ ok: true } as Response)

    render(<RichTextEditor content={CONTENT} onChange={jest.fn()} projectId="proj-1" />)
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['img'], 'photo.jpg', { type: 'image/jpeg' })
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true })
    fireEvent.change(fileInput)

    await new Promise((r) => setTimeout(r, 0))

    expect(global.fetch).toHaveBeenCalledTimes(2)
    const [firstCall, secondCall] = (global.fetch as jest.Mock).mock.calls
    expect(firstCall[0]).toBe('/api/v1/projects/proj-1/changelog/image-upload-url')
    expect(secondCall[0]).toBe('https://r2.example.com/upload')
    expect(secondCall[1]).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/jpeg' } })
  })

  it('shows alert when presigned URL request fails', async () => {
    window.alert = jest.fn()
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: false,
      json: async () => ({ message: 'Image upload not configured' }),
    } as Response)

    render(<RichTextEditor content={CONTENT} onChange={jest.fn()} projectId="proj-1" />)
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['img'], 'photo.png', { type: 'image/png' })
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true })
    fireEvent.change(fileInput)

    await new Promise((r) => setTimeout(r, 0))

    expect(window.alert).toHaveBeenCalledWith('Image upload not configured')
  })
})
