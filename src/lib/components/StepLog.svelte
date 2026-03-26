<script lang="ts">
  import type { StepEntry } from '../types'

  interface Props {
    steps: StepEntry[]
    class?: string
  }

  let { steps, class: className = '' }: Props = $props()
</script>

{#if steps.length > 0}
  <div class="bg-base-200/60 rounded-xl p-3 md:p-4 font-mono text-[11px] md:text-sm leading-relaxed max-h-40 md:max-h-52 overflow-y-auto overflow-x-hidden scrollbar-thin {className}">
    {#each steps as step}
      <div
        class="flex items-center gap-2"
        class:text-success={step.status === 'done'}
        class:text-warning={step.status === 'loading'}
        class:text-error={step.status === 'error'}
        class:opacity-60={!step.status}
      >
        {#if step.status === 'loading'}
          <span class="loading loading-spinner loading-xs shrink-0"></span>
        {:else if step.status === 'done'}
          <span class="shrink-0">&#10003;</span>
        {:else if step.status === 'error'}
          <span class="shrink-0">&#10007;</span>
        {:else}
          <span class="w-3 shrink-0"></span>
        {/if}
        <span class="break-all">{step.text}</span>
      </div>
    {/each}
  </div>
{/if}
