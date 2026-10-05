import { LoadingState } from '@/components/states'

/**
 * The route-level loading state.
 *
 * It is a distinct design from both the empty and error states because it means something
 * different: "not here yet, and you can see the shape of what is coming". The widths are
 * deliberately uneven, because a skeleton of perfectly equal bars looks like a loading screen
 * from a template rather than a report being assembled.
 */
export default function Loading() {
  return <LoadingState label="Comparing recordings — canonicalising, tokenising, diffing." />
}
