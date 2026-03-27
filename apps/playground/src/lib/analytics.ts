import posthog from 'posthog-js'

const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined
const host = (import.meta.env.VITE_POSTHOG_HOST as string) || 'https://eu.i.posthog.com'

let initialized = false

/** Initialize PostHog. Safe to call multiple times, only runs once. */
export function initAnalytics() {
  if (initialized || !key) return
  initialized = true

  posthog.init(key, {
    api_host: host,
    person_profiles: 'identified_only',
    capture_pageview: false, // manual tracking on hash change
    capture_pageleave: true,
    persistence: 'memory', // cookieless by default, privacy-first
    autocapture: false,
  })

  // Track initial page view
  trackPageView()

  // Track hash-based navigation
  window.addEventListener('hashchange', trackPageView)
}

function trackPageView() {
  const page = window.location.hash.slice(1) || 'status'
  posthog.capture('$pageview', {
    $current_url: window.location.href,
    page,
  })
}
