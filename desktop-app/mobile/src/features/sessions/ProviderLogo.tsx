import { SvgXml } from "react-native-svg";
import { Image } from "react-native";
import { HANDWORK_MARK } from "@/ui/brand";

import type { Harness } from "@/features/workspace/types";
import { useColors } from "@/ui/theme";

import { MONOCHROME_PROVIDERS, PROVIDER_SVGS } from "./providerSvgs";

/** The provider's mark, as in the desktop HarnessIcon. Single-color marks take `color`. */
export function ProviderLogo({
  harness,
  size = 16,
  color: givenColor,
}: {
  harness: Harness;
  size?: number;
  color?: string;
}) {
  const colors = useColors();
  const color = givenColor ?? colors.content;
  if (harness === "handwork")
    return (
      <Image
        source={HANDWORK_MARK}
        style={{ width: size, height: size, tintColor: color }}
      />
    );
  return (
    <SvgXml
      xml={PROVIDER_SVGS[harness]}
      width={size}
      height={size}
      color={MONOCHROME_PROVIDERS.has(harness) ? color : undefined}
    />
  );
}
