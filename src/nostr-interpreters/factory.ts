import { InterpreterParams } from "../types";
import { NostrInterpreterClass, NostrInterpreterFactory } from "./classes";
import { applyInteractionsByTag, applyZapInteractions, validateEachEventHasAuthor } from "./callbacks";
import { NostrInterpreterParams } from "./types";

export const InterpreterFactory = new NostrInterpreterFactory()

interface FollowsParams extends NostrInterpreterParams {}
InterpreterFactory.set('nostr-3', () => new NostrInterpreterClass<FollowsParams>(
  {
    interpretKind: 3,
    fetchKinds : [3],
    label: "Follows Network",
    description: 'Interprets follow events published by actors or subjects.',
    allowedActorTypes: ['pubkey', 'p'],
    allowedSubjectTypes: ['pubkey', 'p'],
    defaultParams : {
      value : 1,
      confidence : .5,
      actorType: 'pubkey',
      subjectType: 'p'
    },
    validate : validateEachEventHasAuthor,
    interpret : (instance, fetchedIndex) => {
      return applyInteractionsByTag(instance as NostrInterpreterClass<FollowsParams>, fetchedIndex)
    }
  }
))


interface MutesParams extends NostrInterpreterParams {}
InterpreterFactory.set('nostr-10000', () => new NostrInterpreterClass<MutesParams>(
  {
    interpretKind: 10000,
    fetchKinds : [10000],
    label: "Mutes Network",
    description: 'Interprets mutes events published by actors or subjects.',
    allowedActorTypes: ['pubkey', 'p'],
    allowedSubjectTypes: ['pubkey', 'p'],
    defaultParams : {
      value : 0,
      confidence : .5,
      actorType: 'pubkey',
      subjectType: 'p'
    },
    interpret : (instance, fetchedIndex) => {
      return applyInteractionsByTag(instance as NostrInterpreterClass<MutesParams>, fetchedIndex)
    }
  }
))

interface ReportsParams extends NostrInterpreterParams {
  nudity : number
  malware : number
  profanity : number
  illegal : number
  spam : number
  impersonation : number
  other : number
}
InterpreterFactory.set('nostr-1984', () => new NostrInterpreterClass<ReportsParams>(
  {
    interpretKind: 1984,
    fetchKinds : [1984],
    label: "Reports Network",
    description: 'Interprets report events published by actors or subjects.',
    allowedActorTypes: ['pubkey', 'p'],
    allowedSubjectTypes: ['pubkey', 'p'],
    defaultParams : {
      value : 0,
      confidence : .5,
      actorType: 'pubkey',
      subjectType: 'p',
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

interface HashtagParams extends NostrInterpreterParams {}
InterpreterFactory.set('nostr-1-t', () => new NostrInterpreterClass<HashtagParams>(
  {
    interpretKind: 1,
    fetchKinds : [1],
    label: "Hashtag Network",
    description: 'Interprets hashtag occurences in kind 1 notes.',
    allowedActorTypes: ['id'],
    allowedSubjectTypes: ['t'],
    defaultParams : {
      value : 1,
      confidence : .5,
      actorType: 'id',
      subjectType: 't'
    },
    interpret : (instance, fetchedIndex) => {
      return applyInteractionsByTag(instance as NostrInterpreterClass<HashtagParams>, fetchedIndex)
    }
  }
))


interface ZapParams extends NostrInterpreterParams {}
InterpreterFactory.set('nostr-9735', () => new NostrInterpreterClass<ZapParams>(
  {
    interpretKind: 9735,
    fetchKinds : [9735, 9734],
    label: "Zap Network",
    description: 'Interprets zap reciepts from zap requests published by actors or subjects.',
    allowedActorTypes: ['P', 'p'],
    allowedSubjectTypes: ['P', 'p'],
    defaultParams : {
      value : 1,
      confidence : .5,
      actorType: 'P',
      subjectType: 'p'
    },
    interpret : (instance, fetchedIndex) => {
      return applyZapInteractions(instance as NostrInterpreterClass<ZapParams>, fetchedIndex)
    }
  }
))
