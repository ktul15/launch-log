'use client'

import { useEffect } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import type { TipTapDoc } from '@/types/changelog'

interface Props {
  content: TipTapDoc
}

export default function RichTextViewer({ content }: Props) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      Link.configure({
        openOnClick: true,
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      }),
      Image.configure({
        HTMLAttributes: { loading: 'lazy' },
      }),
    ],
    content,
    editable: false,
  })

  useEffect(() => {
    return () => {
      editor?.destroy()
    }
  }, [editor])

  if (!editor) return <div className="min-h-[40px] animate-pulse rounded bg-gray-50" />

  return (
    <EditorContent
      editor={editor}
      className="prose prose-sm max-w-none"
    />
  )
}
