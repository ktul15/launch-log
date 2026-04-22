'use client'

import { useState, useEffect, FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/api'

function toClientSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export default function OnboardingWizard() {
  const router = useRouter()

  const [step, setStep] = useState<1 | 2>(1)

  const [orgName, setOrgName] = useState('')
  const [orgSlug, setOrgSlug] = useState('')
  const [orgSlugEdited, setOrgSlugEdited] = useState(false)
  // Track server-loaded values to send only changed fields on PATCH.
  const [initialOrgName, setInitialOrgName] = useState('')
  const [initialOrgSlug, setInitialOrgSlug] = useState('')

  const [projectName, setProjectName] = useState('')
  const [projectSlug, setProjectSlug] = useState('')
  const [projectSlugEdited, setProjectSlugEdited] = useState(false)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [initialLoading, setInitialLoading] = useState(true)
  const [redirecting, setRedirecting] = useState(false)
  const [initError, setInitError] = useState('')

  useEffect(() => {
    apiFetch('/api/v1/org')
      .then((res) => {
        if (!res.ok) throw new Error('fetch_failed')
        return res.json()
      })
      .then((data: { name?: string; slug?: string; projectCount?: number }) => {
        // User has already completed onboarding — redirect away.
        // Set redirecting=true (keeps skeleton visible) before navigating so there's
        // no flash of the step 1 form during the async navigation.
        if ((data.projectCount ?? 0) > 0) {
          setInitialLoading(false)
          setRedirecting(true)
          router.replace('/dashboard')
          return
        }
        const name = data.name ?? ''
        const slug = data.slug ?? ''
        setOrgName(name)
        setOrgSlug(slug)
        setInitialOrgName(name)
        setInitialOrgSlug(slug)
        setInitialLoading(false)
      })
      .catch(() => {
        setInitError('Failed to load organisation data. Please refresh.')
        setInitialLoading(false)
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleOrgNameChange(value: string) {
    setOrgName(value)
    if (!orgSlugEdited) {
      setOrgSlug(toClientSlug(value))
    }
  }

  function handleOrgSlugChange(value: string) {
    setOrgSlug(value)
    setOrgSlugEdited(true)
  }

  function handleProjectNameChange(value: string) {
    setProjectName(value)
    if (!projectSlugEdited) {
      setProjectSlug(toClientSlug(value))
    }
  }

  function handleProjectSlugChange(value: string) {
    setProjectSlug(value)
    setProjectSlugEdited(true)
  }

  async function handleOrgSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')

    if (!orgSlug.trim()) {
      setError('Please enter a workspace URL.')
      return
    }

    // If nothing changed, skip the PATCH and advance directly.
    const payload: Record<string, string> = {}
    if (orgName !== initialOrgName) payload.name = orgName
    if (orgSlug !== initialOrgSlug) payload.slug = orgSlug

    if (Object.keys(payload).length === 0) {
      setStep(2)
      return
    }

    setLoading(true)

    try {
      const res = await apiFetch('/api/v1/org', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      })

      if (res.ok) {
        setStep(2)
        return
      }

      const body = await res.json().catch(() => ({})) as Record<string, unknown>
      if (res.status === 409) {
        setError('Slug is already taken. Please choose a different one.')
      } else {
        const msg = body?.message
        setError(typeof msg === 'string' ? msg : 'Something went wrong. Please try again.')
      }
    } catch {
      setError('Unable to connect. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  async function handleProjectSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')

    if (!projectSlug.trim()) {
      setError('Please enter a project slug.')
      return
    }

    setLoading(true)

    try {
      const res = await apiFetch('/api/v1/projects', {
        method: 'POST',
        body: JSON.stringify({ name: projectName, slug: projectSlug }),
      })

      if (res.status === 201) {
        router.replace('/dashboard')
        return
      }

      const body = await res.json().catch(() => ({})) as Record<string, unknown>
      if (res.status === 409) {
        setError('A project with this slug already exists. Please choose a different one.')
      } else {
        const msg = body?.message
        setError(typeof msg === 'string' ? msg : 'Something went wrong. Please try again.')
      }
    } catch {
      setError('Unable to connect. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  if (initialLoading || redirecting) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div data-testid="loading-skeleton" className="w-full max-w-md bg-white rounded-xl shadow-md p-8 animate-pulse">
          <div className="h-6 bg-gray-200 rounded w-3/4 mb-4" />
          <div className="h-4 bg-gray-200 rounded w-1/2 mb-8" />
          <div className="h-10 bg-gray-200 rounded mb-4" />
          <div className="h-10 bg-gray-200 rounded mb-4" />
          <div className="h-10 bg-gray-200 rounded" />
        </div>
      </div>
    )
  }

  if (initError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-full max-w-md bg-white rounded-xl shadow-md p-8">
          <p role="alert" className="text-sm text-red-600 mb-4">{initError}</p>
          <button
            onClick={() => window.location.reload()}
            className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg px-4 py-2 text-sm transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-md bg-white rounded-xl shadow-md p-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Welcome to LaunchLog</h1>
        <p className="text-sm text-gray-500 mb-6">Let&apos;s get your workspace set up.</p>

        {/* Progress indicator */}
        <div className="flex items-center mb-8">
          <div
            className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium flex-shrink-0
              ${step >= 1 ? 'bg-indigo-600 text-white' : 'bg-gray-200 text-gray-500'}`}
          >
            {step > 1 ? '✓' : '1'}
          </div>
          <div className="flex-1 flex flex-col items-start ml-2 mr-4 min-w-0">
            <span className={`text-xs font-medium ${step === 1 ? 'text-indigo-600' : 'text-gray-400'}`}>
              Organisation
            </span>
          </div>
          <div className={`flex-shrink-0 w-8 h-0.5 mx-1 ${step > 1 ? 'bg-indigo-600' : 'bg-gray-200'}`} />
          <div
            className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium flex-shrink-0 ml-1
              ${step >= 2 ? 'bg-indigo-600 text-white' : 'bg-gray-200 text-gray-500'}`}
          >
            2
          </div>
          <div className="flex-1 flex flex-col items-start ml-2 min-w-0">
            <span className={`text-xs font-medium ${step === 2 ? 'text-indigo-600' : 'text-gray-400'}`}>
              First project
            </span>
          </div>
        </div>

        {step === 1 && (
          <form onSubmit={handleOrgSubmit} noValidate className="space-y-4">
            <div>
              <label htmlFor="org-name" className="block text-sm font-medium text-gray-700 mb-1">
                Organisation name
              </label>
              <input
                id="org-name"
                type="text"
                required
                value={orgName}
                onChange={(e) => handleOrgNameChange(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                placeholder="Acme Inc."
              />
            </div>

            <div>
              <label htmlFor="org-slug" className="block text-sm font-medium text-gray-700 mb-1">
                Workspace URL
              </label>
              <input
                id="org-slug"
                type="text"
                required
                value={orgSlug}
                onChange={(e) => handleOrgSlugChange(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                placeholder="acme-inc"
              />
              <p className="text-xs text-gray-400 mt-1">
                launchlog.io/<span className="font-mono">{orgSlug || '…'}</span>
              </p>
            </div>

            {error && (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-medium rounded-lg px-4 py-2 text-sm transition-colors"
            >
              {loading ? 'Saving…' : 'Continue'}
            </button>
          </form>
        )}

        {step === 2 && (
          <form onSubmit={handleProjectSubmit} noValidate className="space-y-4">
            <div>
              <label htmlFor="project-name" className="block text-sm font-medium text-gray-700 mb-1">
                Project name
              </label>
              <input
                id="project-name"
                type="text"
                required
                value={projectName}
                onChange={(e) => handleProjectNameChange(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                placeholder="My Product"
              />
            </div>

            <div>
              <label htmlFor="project-slug" className="block text-sm font-medium text-gray-700 mb-1">
                Project slug
              </label>
              <input
                id="project-slug"
                type="text"
                required
                value={projectSlug}
                onChange={(e) => handleProjectSlugChange(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                placeholder="my-product"
              />
              <p className="text-xs text-gray-400 mt-1">Used in your public changelog URL</p>
            </div>

            {error && (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-medium rounded-lg px-4 py-2 text-sm transition-colors"
            >
              {loading ? 'Creating project…' : 'Create project'}
            </button>

            <button
              type="button"
              onClick={() => { setStep(1); setError('') }}
              className="w-full border border-gray-300 text-gray-700 hover:bg-gray-50 font-medium rounded-lg px-4 py-2 text-sm transition-colors"
            >
              Back
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
