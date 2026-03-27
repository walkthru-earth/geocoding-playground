<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    left: Snippet
    right: Snippet
    initialSplit?: number
    minLeft?: number
    minRight?: number
    mobileMapHeight?: string
  }

  let {
    left,
    right,
    initialSplit = 42,
    minLeft = 340,
    minRight = 280,
    mobileMapHeight = '40dvh',
  }: Props = $props()

  // svelte-ignore state_referenced_locally — intentional: capture initial value only
  let splitPct = $state(initialSplit)
  let dragging = $state(false)
  let container: HTMLDivElement
  let isMobile = $state(typeof window !== 'undefined' && window.innerWidth < 768)

  $effect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const handler = () => { isMobile = !mq.matches }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  })

  function startDrag(e: MouseEvent | TouchEvent) {
    e.preventDefault()
    dragging = true

    const onMove = (ev: MouseEvent | TouchEvent) => {
      if (!container) return
      const cx = 'touches' in ev ? ev.touches[0].clientX : ev.clientX
      const rect = container.getBoundingClientRect()
      const x = cx - rect.left
      const pct = (x / rect.width) * 100
      const lo = (minLeft / rect.width) * 100
      const hi = 100 - (minRight / rect.width) * 100
      splitPct = Math.max(lo, Math.min(hi, pct))
    }

    const onEnd = () => {
      dragging = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onEnd)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onEnd)
    window.addEventListener('touchmove', onMove)
    window.addEventListener('touchend', onEnd)
  }
</script>

<!--
  Single container — each snippet rendered exactly once.
  CSS flex-direction switches between column (mobile) and row (desktop).
  This avoids double-rendering the map which breaks bind:this.
-->
<div
  bind:this={container}
  class="flex h-full"
  class:flex-col={isMobile}
  class:flex-row={!isMobile}
  class:select-none={dragging}
  class:cursor-col-resize={dragging}
>
  <!-- Map panel: on top (mobile) or right side (desktop) -->
  <div
    class="shrink-0"
    class:order-2={!isMobile}
    style={isMobile
      ? `height: ${mobileMapHeight}; border-bottom: 1px solid var(--wt-border-subtle)`
      : 'flex: 1; min-width: 0'}
  >
    {@render right()}
  </div>

  <!-- Resizable divider (desktop only) -->
  {#if !isMobile}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="w-px shrink-0 relative group cursor-col-resize z-10 order-1"
      onmousedown={startDrag}
      ontouchstart={startDrag}
      role="separator"
      aria-orientation="vertical"
    >
      <div class="absolute inset-0 bg-base-content/[0.06] group-hover:bg-primary/20 transition-colors duration-200"></div>
      <div class="absolute inset-y-0 -left-2.5 -right-2.5"></div>
      <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
        <div class="w-0.5 h-1.5 rounded-full bg-primary/60"></div>
        <div class="w-0.5 h-1.5 rounded-full bg-primary/60"></div>
        <div class="w-0.5 h-1.5 rounded-full bg-primary/60"></div>
      </div>
    </div>
  {/if}

  <!-- Controls panel: below map (mobile) or left side (desktop) -->
  <div
    class="overflow-y-auto scrollbar-thin"
    class:flex-1={isMobile}
    style={isMobile ? '' : `width: ${splitPct}%; order: 0`}
  >
    {@render left()}
  </div>
</div>
