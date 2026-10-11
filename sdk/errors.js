const { formatUnits } = require('ethers');

const usdc = (v) => formatUnits(v, 18);
const when = (seconds) => new Date(Number(seconds) * 1000).toUTCString();

// Every error the contracts can raise, turned into a code, an HTTP status and a plain sentence.
// `a` holds the error's arguments (for example the amounts in LowBalance).
const CATALOG = {
  // ----- account state -----
  Locked: (a) => ({ code: 'ACCOUNT_LOCKED', http: 423, text: `This account is locked after too many wrong passwords. It unlocks on ${when(a.until)}.`, details: { lockedUntil: Number(a.until) } }),
  LockedForever: () => ({ code: 'ACCOUNT_LOCKED_PERMANENTLY', http: 423, text: 'This account has been locked for security. Please contact ZionMatrix support to unlock it.' }),
  CardFrozen: () => ({ code: 'ACCOUNT_FROZEN', http: 423, text: 'This account is frozen. Please contact ZionMatrix support.' }),
  WithdrawalsHalted: () => ({ code: 'WITHDRAWALS_PAUSED', http: 503, retry: true, text: 'Withdrawals are paused for a moment. Please try again later.' }),
  NothingToUnlock: () => ({ code: 'NOTHING_TO_UNLOCK', http: 409, text: 'This account is not locked.' }),
  AlreadyFrozen: () => ({ code: 'ALREADY_FROZEN', http: 409, text: 'This account is already frozen.' }),

  // ----- requests -----
  NotRelayer: () => ({ code: 'NOT_AUTHORISED', http: 403, text: 'This server is not authorised to act for this account.' }),
  Expired: () => ({ code: 'REQUEST_EXPIRED', http: 408, retry: true, text: 'This request took too long and expired. Please try again.' }),
  ZeroAmount: () => ({ code: 'INVALID_AMOUNT', http: 400, text: 'The amount must be more than zero (or the account has nothing to withdraw).' }),
  LowBalance: (a) => ({ code: 'INSUFFICIENT_BALANCE', http: 409, text: `Insufficient balance. You asked for ${usdc(a.wanted)} USDC but only ${usdc(a.have)} USDC is available.`, details: { requested: usdc(a.wanted), available: usdc(a.have) } }),
  ZeroAddress: () => ({ code: 'INVALID_ADDRESS', http: 400, text: 'An address is missing.' }),
  BadAddress: () => ({ code: 'INVALID_ADDRESS', http: 400, text: 'That address cannot be used here (it is empty, the same as the current one, or reserved).' }),
  SameKey: () => ({ code: 'PASSWORD_UNCHANGED', http: 400, text: 'The new access password must be different from the current one.' }),
  NothingPending: () => ({ code: 'NOTHING_PENDING', http: 409, text: 'There is no pending change to apply or cancel.' }),
  TooEarly: (a) => ({ code: 'TOO_EARLY', http: 409, retry: true, text: `This change is not ready yet. It can be confirmed after ${when(a.readyAt)}.`, details: { readyAt: Number(a.readyAt) } }),
  AlreadyRelayer: () => ({ code: 'ALREADY_AUTHORISED', http: 409, text: 'That server is already authorised for this account.' }),
  LastRelayer: () => ({ code: 'LAST_RELAYER', http: 409, text: 'You cannot remove the last authorised server. Add another one first.' }),
  BadId: () => ({ code: 'INVALID_BUSINESS_ID', http: 400, text: 'The business ID is invalid.' }),

  // ----- upgrades -----
  NotApproved: () => ({ code: 'UPGRADE_NOT_ALLOWED', http: 409, text: 'That version has not been approved.' }),
  BadImplementation: () => ({ code: 'UPGRADE_NOT_ALLOWED', http: 409, text: 'That version cannot be used (wrong type, already in use, or built for a different factory).' }),
  UseUpgrade: () => ({ code: 'UPGRADE_NOT_ALLOWED', http: 409, text: 'Upgrades must go through the access-password flow.' }),
  NotProposed: () => ({ code: 'UPGRADE_NOT_PROPOSED', http: 409, text: 'That version was not proposed (or it was cancelled).' }),
  AlreadyApproved: () => ({ code: 'UPGRADE_ALREADY_APPROVED', http: 409, text: 'That version is already approved.' }),

  // ----- factory and permissions -----
  CardExists: () => ({ code: 'ACCOUNT_EXISTS', http: 409, text: 'This business already has an account.' }),
  EnforcedPause: () => ({ code: 'CREATION_PAUSED', http: 503, retry: true, text: 'Creating new accounts is paused for a moment.' }),
  NotGuardian: () => ({ code: 'NOT_PERMITTED', http: 403, text: 'This wallet is not allowed to do that (guardian or recovery role needed).' }),
  NotRecovery: () => ({ code: 'NOT_PERMITTED', http: 403, text: 'This wallet is not allowed to do that (recovery role needed).' }),
  AccessControlUnauthorizedAccount: () => ({ code: 'NOT_PERMITTED', http: 403, text: 'This wallet does not have the role needed for that action.' }),
  AccessControlEnforcedDefaultAdminDelay: () => ({ code: 'TOO_EARLY', http: 409, retry: true, text: 'The admin handover delay has not finished yet.' }),
  NoChange: () => ({ code: 'NO_CHANGE', http: 409, text: 'Nothing to change: it is already in that state.' }),
};

class ZionError extends Error {
  constructor({ code, message, httpStatus = 500, retryable = false, details = {}, reason = null, cause = null }) {
    super(message);
    this.name = 'ZionError';
    this.code = code; // stable, for your code to branch on
    this.reason = reason; // the raw contract error name, if any
    this.httpStatus = httpStatus; // a sensible HTTP status for your API
    this.retryable = retryable;
    this.details = details;
    if (cause) this.cause = cause;
  }

  // Ready to send to a client: res.status(err.httpStatus).json(err.toJSON())
  toJSON() {
    return { error: { code: this.code, message: this.message, retryable: this.retryable, details: this.details } };
  }
}

function wrongPassword({ attemptsLeft, lockedUntil, lockedForever }) {
  if (lockedForever) {
    return new ZionError({
      code: 'WRONG_PASSWORD_LOCKED_PERMANENTLY',
      message: 'Wrong access password. This account is now locked for security. Please contact ZionMatrix support to unlock it.',
      httpStatus: 423,
      details: { attemptsLeft: 0, lockedForever: true },
    });
  }
  if (lockedUntil) {
    return new ZionError({
      code: 'WRONG_PASSWORD_LOCKED',
      message: `Wrong access password. Too many attempts: this account is locked until ${when(lockedUntil)}.`,
      httpStatus: 423,
      details: { attemptsLeft: 0, lockedUntil: Number(lockedUntil) },
    });
  }
  const s = attemptsLeft === 1 ? '' : 's';
  const warn = attemptsLeft === 1 ? ' If it fails again the account will be locked for 24 hours.' : '';
  return new ZionError({
    code: 'WRONG_PASSWORD',
    message: `Wrong access password. ${attemptsLeft} attempt${s} left before this account is locked.${warn}`,
    httpStatus: 401,
    details: { attemptsLeft },
  });
}

// Turns anything thrown while talking to the chain into a ZionError with a plain message.
// `interfaces` are the ethers Interfaces that may know the contract error.
function toZionError(e, ...interfaces) {
  if (e instanceof ZionError) return e;

  let parsed = null;
  for (const iface of interfaces.flat()) {
    try {
      parsed = e.data ? iface.parseError(e.data) : null;
    } catch { /* try the next interface */ }
    if (parsed) break;
  }
  const name = parsed?.name || e.revert?.name || null;

  if (name && CATALOG[name]) {
    const c = CATALOG[name](parsed?.args ?? {});
    return new ZionError({ code: c.code, message: c.text, httpStatus: c.http, retryable: !!c.retry, details: c.details, reason: name, cause: e });
  }
  if (e.code === 'INSUFFICIENT_FUNDS') {
    return new ZionError({ code: 'RELAYER_OUT_OF_FUNDS', message: 'The server wallet has run out of USDC for network fees. Please try again shortly.', httpStatus: 503, retryable: true, cause: e });
  }
  if (['NETWORK_ERROR', 'TIMEOUT', 'SERVER_ERROR'].includes(e.code) || /underpriced|timeout|ECONN|fetch failed/i.test(e.message || '')) {
    return new ZionError({ code: 'NETWORK_ERROR', message: 'Could not reach the network. Please try again.', httpStatus: 503, retryable: true, cause: e });
  }
  return new ZionError({
    code: 'UNKNOWN_ERROR',
    message: `Something went wrong: ${e.shortMessage || e.message}`,
    httpStatus: 500,
    reason: name,
    cause: e,
  });
}

module.exports = { ZionError, toZionError, wrongPassword, CATALOG };
