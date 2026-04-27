export default function PublicPageLoading() {
  return (
    <div className="min-h-screen bg-white">
      <div className="border-b border-gray-200 px-4 py-6">
        <div className="mx-auto max-w-3xl">
          <div className="h-3 w-24 animate-pulse rounded bg-gray-200" />
          <div className="mt-2 h-7 w-48 animate-pulse rounded bg-gray-200" />
        </div>
      </div>
      <div className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-8 flex gap-1 border-b border-gray-200 pb-2">
          {[80, 70, 72].map((w, i) => (
            <div key={i} className={`h-8 w-${w} animate-pulse rounded bg-gray-200`} />
          ))}
        </div>
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="border-b border-gray-100 pb-4">
              <div className="mb-2 h-3 w-20 animate-pulse rounded bg-gray-200" />
              <div className="h-5 w-64 animate-pulse rounded bg-gray-200" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
