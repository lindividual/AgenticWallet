import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';
import { App } from './App';

const rootRoute = createRootRoute({
  component: Outlet,
});

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: App,
});

const tradeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/trade',
  component: App,
});

const walletRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/wallet',
  component: App,
});

const walletAssetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/wallet/asset/$chain/$contract',
  component: App,
});

const articleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/article/$articleId',
  component: App,
});

const tokenRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/token/$chain/$contract',
  component: App,
});

const marketRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/market/$marketType/$itemId',
  component: App,
});

const routeTree = rootRoute.addChildren([homeRoute, tradeRoute, walletRoute, walletAssetRoute, articleRoute, tokenRoute, marketRoute]);

export const router = createRouter({
  routeTree,
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
