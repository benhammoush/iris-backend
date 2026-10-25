/**
 * Exact atomic-quantity operations and canonical Solana asset identity.
 * @packageDocumentation
 */

import { CHAIN, SOL_MINT } from './constants.ts';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Validate the base58 alphabet and decoded public-key length at the input boundary. */
export function isBase58PublicKey(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length < 32 ||
    value.length > 44 ||
    ![...value].every((character) => BASE58.includes(character))
  )
    return false;
  let bytes = [0];
  for (const character of value) {
    let carry = BASE58.indexOf(character);
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index] * 58;
      bytes[index] = carry & 255;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 255);
      carry >>= 8;
    }
  }
  const leadingZeroes = value.match(/^1*/)?.[0].length ?? 0;
  const encodedBytes = bytes.length === 1 && bytes[0] === 0 ? 0 : bytes.length;
  return leadingZeroes + encodedBytes === 32;
}

/** Format an exact atomic quantity at the supplied decimal precision, or return null for invalid input. */
export function formatAtomicAmount(
  rawAmount: unknown,
  decimals: unknown,
): string | null {
  if (
    typeof rawAmount !== 'string' ||
    !/^\d+$/.test(rawAmount) ||
    typeof decimals !== 'number' ||
    !Number.isInteger(decimals) ||
    decimals < 0
  )
    return null;
  const digits = rawAmount.padStart(decimals + 1, '0');
  if (decimals === 0) return digits;
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Sum supported atomic quantities exactly with bigint arithmetic, or return null for invalid input. */
export function addAtomicAmounts(
  amounts: readonly (string | number | bigint | boolean)[],
): string | null {
  try {
    return amounts
      .reduce<bigint>((total, amount) => total + BigInt(amount), 0n)
      .toString();
  } catch {
    return null;
  }
}

/** Convert a display decimal only when its precision can be represented safely for valuation. */
export function decimalValue(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  // A portfolio value must not silently round an amount that cannot be represented safely.
  if (value.replace(/^0+|\./g, '').replace(/^0+/, '').length > 15) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Build canonical Solana asset identifiers and the native-asset flag from the mint. */
export function assetIdentity(mint: string) {
  return {
    chain: CHAIN,
    assetId: mint,
    mint,
    contractId: mint,
    isNative: mint === SOL_MINT,
  };
}
