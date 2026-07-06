"use client";

import { useCallback, type ReactNode } from "react";
import { encodeFunctionData, numberToHex, type Hex } from "viem";
import { useAccount } from "wagmi";
import {
  useLogin,
  usePrivy,
  useSendTransaction,
  useWallets,
} from "@privy-io/react-auth";
import {
  WalletActionsContext,
  useWalletWrite,
  type SponsoredTxRequest,
  type WalletActions,
} from "@/components/wallet/wallet-actions";

/**
 * Privy provider: connect via Privy (embedded + external wallets), and submit
 * governance writes gaslessly from the embedded wallet via native "App pays"
 * (EIP-7702) sponsorship — a specific `chainId` per call, no network switch, no
 * per-tx prompt (`showWalletUIs: false`). External wallets connected through
 * Privy can't be sponsored, so they fall back to a normal self-paid write.
 *
 * Only mounted inside a `<PrivyProvider>` (privy hooks require that ancestor).
 */
export function PrivyWalletActions({ children }: { children: ReactNode }) {
  const { login } = useLogin();
  const { logout } = usePrivy();
  const { wallets } = useWallets();
  const { sendTransaction } = useSendTransaction();
  const { address } = useAccount();
  const selfPaidWrite = useWalletWrite();

  /** Is the active wallet a Privy embedded wallet (sponsorable)? */
  const activeIsEmbedded = useCallback(() => {
    if (!address) return false;
    const w = wallets.find(
      (x) => x.address?.toLowerCase() === address.toLowerCase(),
    );
    return w?.walletClientType === "privy";
  }, [wallets, address]);

  const sendSponsored = useCallback(
    async (req: SponsoredTxRequest): Promise<Hex> => {
      // External wallet → normal self-paid write (can't be sponsored).
      if (!activeIsEmbedded()) return selfPaidWrite(req);

      const data = encodeFunctionData({
        abi: req.abi as Parameters<typeof encodeFunctionData>[0]["abi"],
        functionName: req.functionName,
        args: req.args as readonly unknown[],
      });
      const { hash } = await sendTransaction(
        {
          to: req.address,
          data,
          chainId: req.chainId,
          ...(req.value !== undefined ? { value: numberToHex(req.value) } : {}),
        },
        { sponsor: true, uiOptions: { showWalletUIs: false } },
      );
      return hash;
    },
    [activeIsEmbedded, selfPaidWrite, sendTransaction],
  );

  const actions: WalletActions = {
    connect: () => login(),
    disconnect: () => void logout(),
    sendSponsored,
  };

  return (
    <WalletActionsContext.Provider value={actions}>
      {children}
    </WalletActionsContext.Provider>
  );
}
