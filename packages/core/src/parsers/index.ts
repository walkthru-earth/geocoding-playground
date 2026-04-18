import type { CountryParser } from '../address-parser'
import { AUParser } from './au'
import { BRParser } from './br'
import { CAParser } from './ca'
import { DEParser } from './de'
import { ESParser } from './es'
import { FRParser } from './fr'
import { ITParser } from './it'
import { JPParser } from './ja'
import { NLParser } from './nl'
import { USParser } from './us'

export const PARSER_REGISTRY: Record<string, CountryParser> = {
  US: new USParser(),
  NL: new NLParser(),
  DE: new DEParser(),
  FR: new FRParser(),
  BR: new BRParser(),
  JP: new JPParser(),
  AU: new AUParser(),
  CA: new CAParser(),
  ES: new ESParser(),
  IT: new ITParser(),
}
