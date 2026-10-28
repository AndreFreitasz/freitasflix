/**
 * App types represented in src/apps.
 * Used in route definitions to determine where to load relevant components from.
 */
export enum AppType {
    /** The Freitas+ app (custom home and title pages). */
    Freitas = 'freitas',
    /** The admin dashboard app. */
    Dashboard = 'dashboard',
    /** The legacy app. */
    Legacy = 'legacy',
    /** The modern React app. */
    Modern = 'modern',
    /** The startup wizard app. */
    Wizard = 'wizard'
}
