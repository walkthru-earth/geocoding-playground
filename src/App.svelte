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
  <nav class="shrink-0 flex items-center justify-between px-5 h-14 border-b border-base-content/[0.06] bg-base-100/90 backdrop-blur-md z-50">
    <!-- Brand -->
    <a href="https://walkthru.earth/links" target="_blank" rel="noopener noreferrer" class="flex items-center gap-2 hover:opacity-80 transition-opacity">
      <img src="{import.meta.env.BASE_URL}favicon.svg" alt="walkthru.earth" class="w-8 h-8" />
      <span class="text-lg font-bold tracking-tight">
        <span class="text-primary">walkthru</span><span class="text-base-content/30">.earth</span>
      </span>
    </a>

    <!-- Navigation pills -->
    <div class="flex items-center gap-1">
      <button class="nav-pill" class:active={page === 'status'} onclick={() => navigate('status')}>Status</button>
      <button class="nav-pill" class:active={page === 'geocode'} onclick={() => navigate('geocode')}>Geocode</button>
      <button class="nav-pill" class:active={page === 'reverse'} onclick={() => navigate('reverse')}>Reverse</button>
      <button class="nav-pill" class:active={page === 'benchmark'} onclick={() => navigate('benchmark')}>Benchmark</button>
    </div>

    <!-- Release selector + DB status -->
    <div class="flex items-center gap-3 text-xs text-base-content/40">
      {#if dbReady}
        <select
          class="select select-xs select-bordered bg-base-200/60 text-base-content/60 font-mono min-w-[10rem]"
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
            DuckDB
          </span>
        {/if}
      {:else if dbError}
        <span class="flex items-center gap-1.5">
          <span class="w-1.5 h-1.5 rounded-full bg-error"></span>
          Error
        </span>
      {:else}
        <span class="loading loading-spinner loading-xs"></span>
      {/if}
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
      {#if page === 'geocode'}
        <GeocodePage />
      {:else}
        <ReversePage />
      {/if}
    {:else}
      <div class="h-full overflow-y-auto scrollbar-thin">
        <div class="container mx-auto px-5 py-6 max-w-6xl">
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
  <footer class="shrink-0 flex items-center justify-center h-7 border-t border-base-content/[0.04] text-[11px] text-base-content/25 gap-1.5">
    <a href="https://walkthru.earth/links" target="_blank" rel="noopener noreferrer" class="font-medium text-primary/40 hover:text-primary/60 transition-colors">walkthru<span class="opacity-40">.earth</span></a>
    <span class="opacity-20">·</span>
    <span>DuckDB-WASM</span>
    <span class="opacity-20">·</span>
    <span>Overture Maps</span>
    <span class="opacity-20">·</span>
    <a href="https://github.com/walkthru-earth/geocoding-playground" class="hover:text-base-content/40 transition-colors" target="_blank" rel="noopener noreferrer">Source</a>
  </footer>
</div>
