import { NostrInterpreterParams } from "./types";
import { NostrInterpreterClass, NostrInterpreterFactory } from "./classes";
import { applyInteractionsByTag, applyHashtagInteractions, applyZapInteractions, validateEachEventHasAuthor } from "./callbacks";

export const InterpreterFactory = new NostrInterpreterFactory()

InterpreterFactory.set('nostr-follows-3', () => new NostrInterpreterClass<FollowsParams>(
  {
    kinds : [3],
    modes: [{
      name: 'actor-follows-subject',
      description: 'Interprets interactions where actor(s) follow subject(s).',
      actorType: 'pubkey',
      subjectType: 'p'
    },
    {
      name: 'subject-follows-actor',
      description: 'Interprets interactions where subject(s) follow actor(s).',
      actorType: 'p',
      subjectType: 'pubkey'
    }],
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
interface FollowsParams extends NostrInterpreterParams {}


InterpreterFactory.set('nostr-mutes-10000', () => new NostrInterpreterClass<MutesParams>(
  {
    kinds : [10000],
    modes: [{
      name: 'actor-mutes-subject',
      description: 'Interprets interactions where actor(s) mute subject(s).',
      actorType: 'pubkey',
      subjectType: 'p'
    },
    {
      name: 'subject-mutes-actor',
      description: 'Interprets interactions where subject(s) mute actor(s).',
      actorType: 'p',
      subjectType: 'pubkey'
    }],
    params : {
      value : 0,
      confidence : .5
    },
    interpret : (instance, fetchedIndex) => {
      return applyInteractionsByTag(instance as NostrInterpreterClass<MutesParams>, fetchedIndex)
    }
  }
))
interface MutesParams extends NostrInterpreterParams {}


InterpreterFactory.set('nostr-reports-1984', () => new NostrInterpreterClass<ReportsParams>(
  {
    kinds : [1984],
    modes: [{
      name: 'actor-reports-subject',
      description: 'Interprets interactions where actor(s) report subject(s).',
      actorType: 'pubkey',
      subjectType: 'p'
    },
    {
      name: 'subject-reports-actor',
      description: 'Interprets interactions where subject(s) report actor(s).',
      actorType: 'p',
      subjectType: 'pubkey'
    }],
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
interface ReportsParams extends NostrInterpreterParams {
  confidence : number,
  nudity : number,
  malware : number,
  profanity : number,
  illegal : number,
  spam : number,
  impersonation : number,
  other : number,
}


InterpreterFactory.set('nostr-hashtags-1', () => new NostrInterpreterClass<HashtagParams>(
  {
    kinds : [1],
    modes: [{
      name: 'event-is-tagged',
      description: 'Interprets interactions where event(s) have hashtag(s).',
      actorType: 'id',
      subjectType: 't'
    }],
    params : {
      value : 1,
      confidence : .5
    },
    interpret : (instance, fetchedIndex) => {
      return applyHashtagInteractions(instance as NostrInterpreterClass<HashtagParams>, fetchedIndex)
    }
  }
))
interface HashtagParams extends NostrInterpreterParams {}


InterpreterFactory.set('nostr-zaps-9735', () => new NostrInterpreterClass<ZapParams>(
  {
    kinds : [9735],
    modes: [{
      name: 'sender-zaps-recipient',
      description: 'Interprets interactions where sender(s) [P tag] zap recipient(s) [p tag].',
      actorType: 'P',
      subjectType: 'p'
    },
    {
      name: 'recipient-zapped-by-sender',
      description: 'Interprets interactions where recipient(s) [p tag] are zapped by sender(s) [P tag].',
      actorType: 'p',
      subjectType: 'P'
    }],
    params : {
      value : 1,
      confidence : .5
    },
    interpret : (instance, fetchedIndex) => {
      return applyZapInteractions(instance as NostrInterpreterClass<ZapParams>, fetchedIndex)
    }
  }
))
interface ZapParams extends NostrInterpreterParams {}
