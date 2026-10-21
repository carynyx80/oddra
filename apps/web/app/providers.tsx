"use client";

import "@rainbow-me/rainbowkit/styles.css";
import { RainbowKitProvider, connectorsForWallets, darkTheme } from "@rainbow-me/rainbowkit";
import {
  coinbaseWallet,
  injectedWallet,
  metaMaskWallet,
  rabbyWallet,
  rainbowWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider, createConfig, http } from "wagmi";
import { chain, rpcUrl, walletConnectProjectId } from "@/lib/config";

const wallets = walletConnectProjectId
  ? [
      {
        groupName: "Wallets",
        wallets: [metaMaskWallet, rabbyWallet, coinbaseWallet, rainbowWallet, walletConnectWallet],
      },
    ]
  : [{ groupName: "Wallets", wallets: [injectedWallet, coinbaseWallet] }];

const connectors = connectorsForWallets(wallets, {
  appName: "Oddra",
  projectId: walletConnectProjectId || "oddra-no-walletconnect",
});

export const wagmiConfig = createConfig({
  chains: [chain],
  connectors,
  transports: { [chain.id]: http(rpcUrl) },
  ssr: true,
});

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 4_000, refetchOnWindowFocus: true } } }),
  );
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={client}>
        <RainbowKitProvider
          theme={darkTheme({
            accentColor: "#B8FF65",
            accentColorForeground: "#050505",
            borderRadius: "small",
            overlayBlur: "small",
          })}
          modalSize="compact"
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
