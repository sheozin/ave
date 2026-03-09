import Stripe from 'https://esm.sh/stripe@14?target=deno'

export const stripe = () =>
  new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
    apiVersion: '2024-04-10',
    httpClient: Stripe.createFetchHttpClient(),
  })
