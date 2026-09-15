/**
 * The `memory` domain declaration: the record schema and the `defineDomain`
 * spec the curated store opens through `ctx.storageDomain`.
 *
 * Records live in one `targets` table keyed by target, so each target owns
 * exactly one document and a write replaces that target's whole entry list.
 * @module @deepseek-ai/dsh-memory-curated/spec
 */

import { z } from 'zod'
import type { MemoryTarget } from '@deepseek-ai/dsh-memory'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/**
 * Durable record of one curated target: its ordered entry list, stored whole.
 * The zod schema validates the list at the durable boundary; the store never
 * persists an entry it did not accept through a write request.
 */
export const curatedTargetRecord = z.object({ entries: z.array(z.string()) })

/** One stored target record, inferred from {@link curatedTargetRecord}. */
export type CuratedTargetRecord = z.infer<typeof curatedTargetRecord>

/**
 * The curated memory domain: version 1 with a single `targets` table. Version 1
 * is the first shipped format, so no migration or compatibility path exists.
 */
export const memoryDomainSpec = defineDomain({
  name: 'memory',
  version: 1,
  tables: { targets: domainTable<MemoryTarget, CuratedTargetRecord>(curatedTargetRecord) },
})
