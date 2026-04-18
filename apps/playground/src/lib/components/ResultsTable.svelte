<script lang="ts">
  import type { AddressRow } from '@walkthru-earth/geocoding-core'

  interface Props {
    results: AddressRow[]
    searchTime?: number
    showDistance?: boolean
    emptyMessage?: string
    onRowClick?: (row: AddressRow) => void
  }

  let {
    results,
    searchTime = 0,
    showDistance = false,
    emptyMessage = '',
    onRowClick,
  }: Props = $props()

  function formatDistance(m: number): string {
    return m < 1000 ? Math.round(m) + 'm' : (m / 1000).toFixed(1) + 'km'
  }
</script>

{#if results.length > 0}
  <div class="text-sm text-base-content/50 mb-2">
    {results.length} address{results.length !== 1 ? 'es' : ''}
    {#if searchTime > 0}
      {' '}in {(searchTime / 1000).toFixed(2)}s
    {/if}
  </div>
  <div class="overflow-x-auto -mx-1">
    <table class="table table-sm">
      <thead>
        <tr class="text-base-content/40">
          <th class="w-8 md:w-10">#</th>
          {#if showDistance}<th>Dist</th>{/if}
          <th>Address</th>
          <th class="hidden sm:table-cell">City</th>
          <th class="hidden sm:table-cell">Postcode</th>
        </tr>
      </thead>
      <tbody>
        {#each results as r, i}
          <tr class="hover:bg-primary/[0.06] cursor-pointer transition-colors group" onclick={() => onRowClick?.(r)}>
            <td>
              <span
                class="inline-flex items-center justify-center w-5 h-5 md:w-6 md:h-6 rounded-full text-2xs md:text-xs font-bold"
                style="background: var({i === 0 ? '--wt-marker-primary' : '--wt-marker-secondary'}); color: var({i === 0 ? '--wt-marker-primary-fg' : '--wt-marker-secondary-fg'})"
              >{i + 1}</span>
            </td>
            {#if showDistance}
              <td class="text-xs md:text-sm font-mono text-primary/70 font-semibold whitespace-nowrap">{formatDistance(r.distance_m ?? 0)}</td>
            {/if}
            <td class="max-w-[180px] md:max-w-[280px] truncate group-hover:text-primary transition-colors font-medium text-xs md:text-sm">
              {r.full_address}
              {#if r.unit}
                <span class="ml-1 inline-flex items-center px-1.5 py-0.5 rounded bg-primary/10 text-primary text-2xs md:text-xs font-semibold align-middle">Unit {r.unit}</span>
              {/if}
            </td>
            <td class="hidden sm:table-cell text-base-content/50 text-xs md:text-sm">{r.city ?? ''}</td>
            <td class="hidden sm:table-cell font-mono text-xs md:text-sm text-base-content/40">{r.postcode ?? ''}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{:else if emptyMessage}
  <div class="text-center py-8 text-base-content/30 text-sm">{emptyMessage}</div>
{/if}
