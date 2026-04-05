<script lang="ts">
  import { initDuckDB, getRelease, getAvailableReleases, switchRelease } from '@walkthru-earth/geocoding-core'
  import { initAnalytics } from './lib/analytics'
  import GeocodePage from './pages/GeocodePage.svelte'
  import StatusPage from './pages/StatusPage.svelte'
  import BenchmarkPage from './pages/BenchmarkPage.svelte'

  const initialHash = window.location.hash.slice(1)
  // Redirect old #reverse URL to unified #geocode page
  if (initialHash === 'reverse') window.location.hash = 'geocode'
  let page = $state(initialHash === 'reverse' ? 'geocode' : (initialHash || 'geocode'))
  let dbReady = $state(false)
  let dbError = $state('')
  let selectedRelease = $state(getRelease())
  let releases = $state(getAvailableReleases())
  let switchingRelease = $state(false)

  const isFullWidth = $derived(page === 'geocode')

  window.addEventListener('hashchange', () => {
    const h = window.location.hash.slice(1) || 'geocode'
    // Redirect old #reverse to unified #geocode page
    if (h === 'reverse') { window.location.hash = 'geocode'; return }
    page = h
  })

  function navigate(p: string) {
    window.location.hash = p
  }

  async function onReleaseSelect(e: Event) {
    const val = (e.target as HTMLSelectElement).value
    if (val === getRelease()) return
    switchingRelease = true
    try {
      await switchRelease(val)
      selectedRelease = val
    } catch (err: any) {
      dbError = err.message
    } finally {
      switchingRelease = false
    }
  }

  // Initialize analytics (no-op if env vars missing)
  initAnalytics()

  $effect(() => {
    initDuckDB()
      .then(() => {
        dbReady = true
        releases = getAvailableReleases()
        selectedRelease = getRelease()
      })
      .catch((e: any) => { dbError = e.message })
  })

  // ── Theme management ──────────────────────────────────────
  type Theme = 'light' | 'dark' | 'system'

  let theme = $state<Theme>((localStorage.getItem('theme') as Theme) ?? 'system')
  let themeMenuOpen = $state(false)

  function resolveSystemTheme(): 'walkthru-light' | 'walkthru-dark' {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'walkthru-dark'
      : 'walkthru-light'
  }

  function applyTheme(t: Theme) {
    theme = t
    localStorage.setItem('theme', t)
    themeMenuOpen = false
    const html = document.documentElement
    if (t === 'system') {
      html.setAttribute('data-theme', resolveSystemTheme())
    } else if (t === 'light') {
      html.setAttribute('data-theme', 'walkthru-light')
    } else {
      html.setAttribute('data-theme', 'walkthru-dark')
    }
  }

  // Apply on mount + watch system preference changes
  $effect(() => {
    applyTheme(theme)

    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const onChange = () => {
        document.documentElement.setAttribute('data-theme', resolveSystemTheme())
      }
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    }
  })

  // Close theme menu on click outside
  function handleClickOutside(e: MouseEvent) {
    if (themeMenuOpen) themeMenuOpen = false
  }
</script>

<div class="h-dvh flex flex-col overflow-hidden" role="presentation" onclick={handleClickOutside}>
  <!-- ── Navbar ───────────────────────────────────────────── -->
  <nav class="sticky top-0 z-50 flex items-center justify-between shrink-0 border-b border-base-content/[0.06] bg-base-100/90 backdrop-blur-md min-h-14 md:min-h-16 px-3 md:px-5">
    <div class="flex items-center gap-2">
      <!-- Hamburger menu (mobile) -->
      <div class="dropdown">
        <div id="tour-burger-menu" tabindex="0" role="button" class="btn btn-ghost btn-sm lg:hidden">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h8m-8 6h16" />
          </svg>
        </div>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <ul tabindex="0" class="menu menu-sm dropdown-content bg-base-200 rounded-box z-50 mt-3 w-52 p-2 shadow-lg border border-base-content/10">
          <li class:active-menu-item={page === 'geocode'}><button onclick={() => navigate('geocode')}>Geocode</button></li>
          <li class:active-menu-item={page === 'status'}><button onclick={() => navigate('status')}>Status</button></li>
          <li class:active-menu-item={page === 'benchmark'}><button onclick={() => navigate('benchmark')}>Benchmark</button></li>
        </ul>
      </div>
      <!-- Brand -->
      <a href="https://walkthru.earth/links" target="_blank" rel="noopener noreferrer" class="flex items-center gap-2 hover:opacity-80 transition-opacity">
        <img src="{import.meta.env.BASE_URL}favicon.svg" alt="walkthru.earth" class="w-7 h-7 md:w-8 md:h-8" />
        <span class="text-lg font-bold tracking-tight hidden sm:inline">
          <span class="text-base-content">walkthru</span><span class="text-base-content/30">.earth</span>
        </span>
      </a>
    </div>

    <!-- Navigation pills (desktop) -->
    <div class="hidden lg:flex items-center gap-1">
      <button id="tour-geocode-pill" class="nav-pill" class:active={page === 'geocode'} onclick={() => navigate('geocode')}>Geocode</button>
      <button class="nav-pill" class:active={page === 'status'} onclick={() => navigate('status')}>Status</button>
      <button class="nav-pill" class:active={page === 'benchmark'} onclick={() => navigate('benchmark')}>Benchmark</button>
    </div>

    <!-- Release selector + theme toggle + DB status -->
    <div class="flex items-center gap-2 md:gap-3">
      {#if dbReady}
        <select
          class="select select-xs select-bordered bg-base-200/60 text-base-content/60 font-mono w-28 md:w-40"
          value={selectedRelease}
          onchange={onReleaseSelect}
          disabled={switchingRelease}
        >
          {#each releases as r}
            <option value={r}>{r}</option>
          {/each}
        </select>
        {#if switchingRelease}
          <span class="loading loading-spinner loading-xs text-primary"></span>
        {:else}
          <span class="flex items-center gap-1.5 text-xs text-base-content/40">
            <span class="w-1.5 h-1.5 rounded-full bg-primary"></span>
            <span class="hidden md:inline">DuckDB</span>
          </span>
        {/if}
      {:else if dbError}
        <span class="flex items-center gap-1.5 text-xs text-base-content/40">
          <span class="w-1.5 h-1.5 rounded-full bg-error"></span>
          <span class="hidden md:inline">Error</span>
        </span>
      {:else}
        <span class="loading loading-spinner loading-xs"></span>
      {/if}

      <!-- Source Cooperative -->
      <a href="https://source.coop/walkthru-earth/indices/addresses-index/v4" target="_blank" rel="noopener noreferrer" class="btn btn-ghost btn-sm btn-square" aria-label="Source Cooperative">
        <img src="{import.meta.env.BASE_URL}source-coop-logo.png" alt="Source Cooperative" class="h-5 w-5 rounded-sm" />
      </a>

      <!-- GitHub -->
      <a href="https://github.com/walkthru-earth/geocoding-playground" target="_blank" rel="noopener noreferrer" class="btn btn-ghost btn-sm btn-square" aria-label="GitHub">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
          <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>
        </svg>
      </a>

      <!-- Theme toggle -->
      <div class="relative">
        <button
          class="btn btn-ghost btn-sm btn-square"
          onclick={(e: MouseEvent) => { e.stopPropagation(); themeMenuOpen = !themeMenuOpen }}
          aria-label="Toggle theme"
        >
          {#if theme === 'light'}
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>
          {:else if theme === 'dark'}
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
            </svg>
          {:else}
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          {/if}
        </button>
        {#if themeMenuOpen}
          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
          <div
            class="absolute right-0 top-full mt-2 w-36 rounded-lg bg-base-200 border border-base-content/10 shadow-lg z-50 py-1"
            role="menu"
            tabindex="-1"
            onclick={(e: MouseEvent) => e.stopPropagation()}
          >
            <button class="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-base-300 transition-colors" class:text-primary={theme === 'light'} onclick={() => applyTheme('light')}>
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
              Light
            </button>
            <button class="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-base-300 transition-colors" class:text-primary={theme === 'dark'} onclick={() => applyTheme('dark')}>
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
              Dark
            </button>
            <button class="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-base-300 transition-colors" class:text-primary={theme === 'system'} onclick={() => applyTheme('system')}>
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              System
            </button>
          </div>
        {/if}
      </div>
    </div>
  </nav>

  <!-- ── Main content ─────────────────────────────────────── -->
  <main class="flex-1 min-h-0">
    {#if !dbReady && !dbError}
      <div class="flex flex-col items-center justify-center h-full gap-4">
        <span class="loading loading-dots loading-lg text-primary"></span>
        <p class="text-base-content/40 text-sm">Initializing DuckDB-WASM...</p>
      </div>
    {:else if dbError}
      <div class="flex items-center justify-center h-full p-6">
        <div role="alert" class="alert alert-error max-w-lg">
          <span>Failed to initialize DuckDB: {dbError}</span>
        </div>
      </div>
    {:else if isFullWidth}
      <GeocodePage />
    {:else}
      <div class="h-full overflow-y-auto scrollbar-thin">
        <div class="container mx-auto px-3 md:px-5 py-4 md:py-6 max-w-6xl">
          {#if page === 'status'}
            <StatusPage />
          {:else if page === 'benchmark'}
            <BenchmarkPage />
          {/if}
        </div>
      </div>
    {/if}
  </main>

  <!-- ── Footer ───────────────────────────────────────────── -->
  <footer class="shrink-0 flex items-center justify-center h-7 border-t border-base-content/[0.04] text-xs text-base-content/25 gap-1 md:gap-1.5 px-2">
    <a href="https://walkthru.earth/links" target="_blank" rel="noopener noreferrer" class="font-medium text-primary/40 hover:text-primary/60 transition-colors">walkthru<span class="opacity-40">.earth</span></a>
    <span class="opacity-20">·</span>
    <span>DuckDB-WASM</span>
    <span class="opacity-20 hidden sm:inline">·</span>
    <span class="hidden sm:inline">Overture Maps</span>
    <span class="opacity-20">·</span>
    <a href="https://github.com/walkthru-earth/geocoding-playground" class="hover:text-base-content/40 transition-colors" target="_blank" rel="noopener noreferrer">Source</a>
  </footer>
</div>
