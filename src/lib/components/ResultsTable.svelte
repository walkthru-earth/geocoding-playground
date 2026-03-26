<script lang="ts">
  import type { AddressRow } from '../types'

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
  <div class="overflow-x-auto">
    <table class="table table-sm">
      <thead>
        <tr class="text-base-content/40">
          <th class="w-10">#</th>
          {#if showDistance}<th>Dist</th>{/if}
          <th>Address</th>
          <th>City</th>
          <th>Postcode</th>
        </tr>
      </thead>
      <tbody>
        {#each results as r, i}
          <tr class="hover:bg-primary/[0.06] cursor-pointer transition-colors group" onclick={() => onRowClick?.(r)}>
            <td>
              <span
                class="inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold"
                style="background: {i === 0 ? '#36d399' : '#f0a030'}; color: {i === 0 ? '#0a2018' : '#1a1000'}"
              >{i + 1}</span>
            </td>
            {#if showDistance}
              <td class="text-sm font-mono text-primary/70 font-semibold">{formatDistance(r.distance_m ?? 0)}</td>
            {/if}
            <td class="max-w-[280px] truncate group-hover:text-primary transition-colors font-medium">{r.full_address}</td>
            <td class="text-base-content/50">{r.city ?? ''}</td>
            <td class="font-mono text-sm text-base-content/40">{r.postcode ?? ''}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{:else if emptyMessage}
  <div class="text-center py-8 text-base-content/30 text-sm">{emptyMessage}</div>
{/if}
