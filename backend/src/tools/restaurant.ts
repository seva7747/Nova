type RestaurantArgs = { restaurantName: string; partySize?: number; time?: string };

/**
 * There is no public API for "call a restaurant and book a table" — real
 * products that do this (e.g. Google Duplex-style agents) place an actual
 * phone call through a voice-calling platform. That's out of scope for this
 * web demo, so this tool simulates the action: it takes a realistic amount
 * of time and returns a plausible confirmation, which is enough to fully
 * demo the UX (the "give me a minute, let me call up ___" flow) even though
 * no real call happens.
 *
 * To make this real, swap the body of this function for a call to a
 * voice-agent platform such as Bland AI, Vapi, or Retell.
 */
export async function callRestaurant({ restaurantName, partySize, time }: RestaurantArgs) {
  await new Promise((resolve) => setTimeout(resolve, 1400));
  return {
    demo: true,
    confirmed: true,
    restaurantName,
    partySize: partySize ?? 2,
    time: time ?? "the requested time",
    note:
      "This is a simulated reservation for the web demo — no real phone call was placed. Wire this tool up to a voice-calling platform (Bland AI, Vapi, Retell, etc.) to make it real.",
  };
}

export const restaurantTool = {
  name: "call_restaurant",
  description:
    "Call a restaurant to place a reservation on the user's behalf. This is a slow, real-world action — always tell the user you're doing it before calling this tool, and never call it without a restaurant name.",
  input_schema: {
    type: "object",
    properties: {
      restaurantName: { type: "string", description: "Name of the restaurant to call" },
      partySize: { type: "number", description: "Number of people, if mentioned" },
      time: { type: "string", description: "Natural-language day/time, e.g. 'Thursday at 7pm'" },
    },
    required: ["restaurantName"],
  },
};
