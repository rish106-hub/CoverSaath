// Names the adult behind a write for the change log (migration 031). `set_config(..., true)` is transaction-local (SET LOCAL),
// so the actor vanishes with the transaction and can never leak to another request on the same pooled connection. The log
// trigger reads it with current_setting('knowvia.actor', true); a write that never set it logs no actor. Call it first inside
// the write transaction, after ownership is proved. The value is an id, never a name or a token.
const ACTOR = /^[A-Za-z0-9_.:-]{1,100}$/;

export async function setSyncActor(database, adultId) {
  if (typeof adultId !== 'string' || !ACTOR.test(adultId)) throw Object.assign(new Error('The actor is not valid.'), { code: 'SYNC_ACTOR_INVALID', statusCode: 400 });
  await database.query("SELECT set_config('knowvia.actor', ?, true)", [adultId]);
}
