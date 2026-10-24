import { CHAIN, SOL_MINT } from './constants.ts';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

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

export function decimalValue(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  // A portfolio value must not silently round an amount that cannot be represented safely.
  if (value.replace(/^0+|\./g, '').replace(/^0+/, '').length > 15) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function assetIdentity(mint: string) {
  return {
    chain: CHAIN,
    assetId: mint,
    mint,
    contractId: mint,
    isNative: mint === SOL_MINT,
  };
}
