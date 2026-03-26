<script lang="ts">
  import { initDuckDB, getRelease, availableReleases, switchRelease, onReleaseChange } from './lib/duckdb'
  import StatusPage from './pages/StatusPage.svelte'
  import GeocodePage from './pages/GeocodePage.svelte'
  import ReversePage from './pages/ReversePage.svelte'
  import BenchmarkPage from './pages/BenchmarkPage.svelte'

  let page = $state(window.location.hash.slice(1) || 'status')
  let dbReady = $state(false)
  let dbError = $state('')
  let selectedRelease = $state(getRelease())
  let releases = $state(availableReleases)
  let switchingRelease = $state(false)

  const isFullWidth = $derived(page === 'geocode' || page === 'reverse')

  window.addEventListener('hashchange', () => {
    page = window.location.hash.slice(1) || 'status'
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

  $effect(() => {
    initDuckDB()
      .then(() => {
        dbReady = true
        releases = availableReleases
        selectedRelease = getRelease()
      })
      .catch((e: any) => { dbError = e.message })
  })
</script>

<div class="h-dvh flex flex-col overflow-hidden">
  <!-- ── Navbar ───────────────────────────────────────────── -->
  <div class="navbar shrink-0 border-b border-base-content/[0.06] bg-base-100/90 backdrop-blur-md z-50 min-h-12 md:min-h-14 px-2 md:px-4">
    <div class="navbar-start gap-1">
      <!-- Hamburger menu (mobile) -->
      <div class="dropdown">
        <div tabindex="0" role="button" class="btn btn-ghost btn-sm lg:hidden">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h8m-8 6h16" />
          </svg>
        </div>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <ul tabindex="0" class="menu menu-sm dropdown-content bg-base-200 rounded-box z-50 mt-3 w-52 p-2 shadow-lg border border-base-content/10">
          <li class:active-menu-item={page === 'status'}><button onclick={() => navigate('status')}>Status</button></li>
          <li class:active-menu-item={page === 'geocode'}><button onclick={() => navigate('geocode')}>Geocode</button></li>
          <li class:active-menu-item={page === 'reverse'}><button onclick={() => navigate('reverse')}>Reverse</button></li>
          <li class:active-menu-item={page === 'benchmark'}><button onclick={() => navigate('benchmark')}>Benchmark</button></li>
        </ul>
      </div>
      <!-- Brand -->
      <a href="https://walkthru.earth/links" target="_blank" rel="noopener noreferrer" class="flex items-center gap-2 hover:opacity-80 transition-opacity">
        <img src="{import.meta.env.BASE_URL}favicon.svg" alt="walkthru.earth" class="w-7 h-7 md:w-8 md:h-8" />
        <span class="text-lg font-bold tracking-tight hidden sm:inline">
          <span class="text-primary">walkthru</span><span class="text-base-content/30">.earth</span>
        </span>
      </a>
    </div>

    <!-- Navigation pills (desktop) -->
    <div class="navbar-center hidden lg:flex">
      <div class="flex items-center gap-1">
        <button class="nav-pill" class:active={page === 'status'} onclick={() => navigate('status')}>Status</button>
        <button class="nav-pill" class:active={page === 'geocode'} onclick={() => navigate('geocode')}>Geocode</button>
        <button class="nav-pill" class:active={page === 'reverse'} onclick={() => navigate('reverse')}>Reverse</button>
        <button class="nav-pill" class:active={page === 'benchmark'} onclick={() => navigate('benchmark')}>Benchmark</button>
      </div>
    </div>

    <!-- Release selector + DB status -->
    <div class="navbar-end gap-2 md:gap-3">
      <div class="flex items-center gap-2 md:gap-3 text-xs text-base-content/40">
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
            <span class="flex items-center gap-1.5">
              <span class="w-1.5 h-1.5 rounded-full bg-primary"></span>
              <span class="hidden md:inline">DuckDB</span>
            </span>
          {/if}
        {:else if dbError}
          <span class="flex items-center gap-1.5">
            <span class="w-1.5 h-1.5 rounded-full bg-error"></span>
            <span class="hidden md:inline">Error</span>
          </span>
        {:else}
          <span class="loading loading-spinner loading-xs"></span>
        {/if}
      </div>
    </div>
  </div>

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
      {#if page === 'geocode'}
        <GeocodePage />
      {:else}
        <ReversePage />
      {/if}
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
  <footer class="shrink-0 flex items-center justify-center h-7 border-t border-base-content/[0.04] text-[10px] md:text-[11px] text-base-content/25 gap-1 md:gap-1.5 px-2">
    <a href="https://walkthru.earth/links" target="_blank" rel="noopener noreferrer" class="font-medium text-primary/40 hover:text-primary/60 transition-colors">walkthru<span class="opacity-40">.earth</span></a>
    <span class="opacity-20">·</span>
    <span>DuckDB-WASM</span>
    <span class="opacity-20 hidden sm:inline">·</span>
    <span class="hidden sm:inline">Overture Maps</span>
    <span class="opacity-20">·</span>
    <a href="https://github.com/walkthru-earth/geocoding-playground" class="hover:text-base-content/40 transition-colors" target="_blank" rel="noopener noreferrer">Source</a>
  </footer>
</div>
