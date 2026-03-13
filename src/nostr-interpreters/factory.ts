import { InterpreterParams } from "../types";
import { NostrInterpreterClass, NostrInterpreterFactory } from "./classes";
import { applyInteractionsByTag, validateEachEventHasAuthor } from "./callbacks";

export const InterpreterFactory = new NostrInterpreterFactory()

InterpreterFactory.set('nostr-follows-3', () => new NostrInterpreterClass<FollowsParams>(
  {
    kinds : [3],
    params : {
      value : 1,
      confidence : .5
    },
    validate : validateEachEventHasAuthor,
    interpret : (instance, fetchedIndex) => {
      return applyInteractionsByTag(instance as NostrInterpreterClass<FollowsParams>, fetchedIndex)
    }
  }
))
interface FollowsParams extends InterpreterParams {}


InterpreterFactory.set('nostr-mutes-10000', () => new NostrInterpreterClass<MutesParams>(
  {
    kinds : [10000],
    params : {
      value : 0,
      confidence : .5
    },
    interpret : (instance, fetchedIndex) => {
      return applyInteractionsByTag(instance as NostrInterpreterClass<MutesParams>, fetchedIndex)
    }
  }
))
interface MutesParams extends InterpreterParams {}


InterpreterFactory.set('nostr-reports-1984', () => new NostrInterpreterClass<ReportsParams>(
  {
    kinds : [1984],
    params : {
      value : 0,
      confidence : .5,
      nudity : 0,
      malware : 0,
      profanity : 0,
      illegal : 0,
      spam : 0,
      impersonation : 0,
      other : 0,
    },
    interpret : (instance, fetchedIndex) => {
      return applyInteractionsByTag(instance as NostrInterpreterClass<ReportsParams>, fetchedIndex, 'p', 1, 2)
    }
  }
))
interface ReportsParams extends InterpreterParams {
  confidence : number,
  nudity : number,
  malware : number,
  profanity : number,
  illegal : number,
  spam : number,
  impersonation : number,
  other : number,
}
