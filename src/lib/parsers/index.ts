import type { CountryParser } from '../address-parser'
import { USParser } from './us'
import { NLParser } from './nl'
import { DEParser } from './de'
import { FRParser } from './fr'
import { BRParser } from './br'
import { JPParser } from './jp'
import { AUParser } from './au'
import { CAParser } from './ca'
import { ESParser } from './es'
import { ITParser } from './it'

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
