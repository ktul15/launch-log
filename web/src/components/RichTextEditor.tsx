'use client'

import { useEditor, EditorContent } from '@tiptap/react'
import { useRef, useState } from 'react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import type { TipTapDoc } from '@/types/changelog'

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

interface Props {
  content: TipTapDoc
  onChange: (json: TipTapDoc) => void
  editable?: boolean
  projectId?: string
}

function isSafeUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function ToolbarButton({
  onClick,
  active,
  title,
  children,
}: {
  onClick: () => void
  active?: boolean
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => {
        e.preventDefault()
        onClick()
      }}
      title={title}
      className={`px-2 py-1 rounded text-sm font-medium transition-colors ${
        active
          ? 'bg-indigo-100 text-indigo-700'
          : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
      }`}
    >
      {children}
    </button>
  )
}

export default function RichTextEditor({ content, onChange, editable = true, projectId }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [imgUploading, setImgUploading] = useState(false)

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      Link.configure({ openOnClick: false }),
      Image,
    ],
    content: content as object,
    editable,
    onUpdate({ editor: e }) {
      onChange(e.getJSON() as TipTapDoc)
    },
  })

  if (!editor) {
    return (
      <div className="border border-gray-300 rounded-lg min-h-[240px] bg-gray-50 animate-pulse" />
    )
  }

  function insertLink() {
    const url = window.prompt('URL')
    if (!url) return
    if (!isSafeUrl(url)) {
      window.alert('Only http:// and https:// URLs are allowed.')
      return
    }
    if (editor!.state.selection.empty) {
      editor!.chain().focus()
        .insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] })
        .run()
    } else {
      editor!.chain().focus().toggleLink({ href: url }).run()
    }
  }

  function insertImage() {
    if (projectId) {
      fileInputRef.current?.click()
    } else {
      const url = window.prompt('Image URL')
      if (!url) return
      if (!isSafeUrl(url)) {
        window.alert('Only http:// and https:// URLs are allowed.')
        return
      }
      editor!.chain().focus().setImage({ src: url }).run()
    }
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !projectId) return

    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      window.alert('Allowed image types: JPEG, PNG, GIF, WebP.')
      return
    }
    if (file.size > MAX_IMAGE_BYTES) {
      window.alert('Image must be 5 MB or smaller.')
      return
    }

    setImgUploading(true)
    try {
      const res = await fetch(`/api/v1/projects/${projectId}/changelog/image-upload-url`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mimeType: file.type }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        window.alert(data.message ?? 'Failed to get upload URL.')
        return
      }
      const { uploadUrl, publicUrl } = await res.json()

      const upload = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      })
      if (!upload.ok) {
        window.alert('Upload failed. Please try again.')
        return
      }

      editor!.chain().focus().setImage({ src: publicUrl }).run()
    } catch {
      window.alert('Upload failed. Please try again.')
    } finally {
      setImgUploading(false)
    }
  }

  return (
    <div className="border border-gray-300 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-indigo-500 focus-within:border-indigo-500">
      {editable && projectId && (
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          className="hidden"
          onChange={handleFileChange}
        />
      )}
      {editable && (
        <div className="flex flex-wrap items-center gap-0.5 px-2 py-1.5 border-b border-gray-200 bg-gray-50">
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleBold().run()}
            active={editor.isActive('bold')}
            title="Bold"
          >
            <strong>B</strong>
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleItalic().run()}
            active={editor.isActive('italic')}
            title="Italic"
          >
            <em>I</em>
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleUnderline().run()}
            active={editor.isActive('underline')}
            title="Underline"
          >
            <span style={{ textDecoration: 'underline' }}>U</span>
          </ToolbarButton>

          <span className="w-px h-4 bg-gray-300 mx-1" />

          <ToolbarButton
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            active={editor.isActive('heading', { level: 2 })}
            title="Heading 2"
          >
            H2
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
            active={editor.isActive('heading', { level: 3 })}
            title="Heading 3"
          >
            H3
          </ToolbarButton>

          <span className="w-px h-4 bg-gray-300 mx-1" />

          <ToolbarButton
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            active={editor.isActive('bulletList')}
            title="Bullet list"
          >
            • List
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            active={editor.isActive('orderedList')}
            title="Ordered list"
          >
            1. List
          </ToolbarButton>

          <span className="w-px h-4 bg-gray-300 mx-1" />

          <ToolbarButton
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
            active={editor.isActive('codeBlock')}
            title="Code block"
          >
            {'</>'}
          </ToolbarButton>

          <span className="w-px h-4 bg-gray-300 mx-1" />

          <ToolbarButton
            onClick={insertLink}
            active={editor.isActive('link')}
            title="Link"
          >
            Link
          </ToolbarButton>
          <ToolbarButton onClick={insertImage} title="Image">
            {imgUploading ? '…' : 'Img'}
          </ToolbarButton>
        </div>
      )}
      <EditorContent
        editor={editor}
        className="prose prose-sm max-w-none p-3 min-h-[200px] focus:outline-none [&_.ProseMirror]:outline-none [&_.ProseMirror]:min-h-[180px]"
      />
    </div>
  )
}
