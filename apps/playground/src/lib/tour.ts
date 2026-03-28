import { driver } from 'driver.js'
import 'driver.js/dist/driver.css'

const TOUR_KEY = 'geocode-tour-seen'
const TOUR_VERSION = '1' // bump to re-show after major UI changes

export function shouldShowTour(): boolean {
  return localStorage.getItem(TOUR_KEY) !== TOUR_VERSION
}

function markTourSeen() {
  localStorage.setItem(TOUR_KEY, TOUR_VERSION)
}

/** Full onboarding tour for the Geocode page. */
export function startGeocodeTour() {
  const driverObj = driver({
    showProgress: true,
    animate: true,
    overlayColor: 'black',
    stagePadding: 8,
    stageRadius: 12,
    popoverClass: 'wt-tour-popover',
    onDestroyStarted: () => {
      markTourSeen()
      driverObj.destroy()
    },
    steps: [
      {
        element: '#tour-country-select',
        popover: {
          title: 'Step 1: Pick a country',
          description:
            'Start here. Select a country to load its address indexes. City and street fields unlock after this.',
          side: 'bottom',
          align: 'start',
        },
      },
      {
        element: '#tour-city-input',
        popover: {
          title: 'Step 2: Search for a city',
          description: 'Type a city name to narrow your search area. This is optional but speeds things up.',
          side: 'bottom',
          align: 'start',
        },
      },
      {
        element: '#tour-address-input',
        popover: {
          title: 'Step 3: Enter an address',
          description:
            'Type a street name, postcode, or full address. Autocomplete suggestions will appear as you type.',
          side: 'bottom',
          align: 'start',
        },
      },
      {
        element: '#tour-search-btn',
        popover: {
          title: 'Step 4: Search',
          description:
            'Hit this button or press Enter to run the geocoding query. Results appear in the table and on the map.',
          side: 'top',
          align: 'start',
        },
      },
    ],
  })

  driverObj.drive()
}

const REVERSE_HINT_KEY = 'geocode-reverse-hint-seen'

/** Returns true if the user has not yet been shown the reverse-geocoding hint. */
export function shouldShowReverseHint(): boolean {
  return localStorage.getItem(REVERSE_HINT_KEY) !== '1'
}

/** Shown when the user clicks the map on the Geocode page, guiding them to Reverse. */
export function showReverseGeocodingHint() {
  localStorage.setItem(REVERSE_HINT_KEY, '1')
  const isMobile = window.innerWidth < 1024
  const driverObj = driver({
    animate: true,
    overlayColor: 'black',
    stagePadding: 8,
    stageRadius: 12,
    popoverClass: 'wt-tour-popover',
    onDestroyStarted: () => {
      driverObj.destroy()
    },
    steps: [
      {
        popover: {
          title: 'Looking for reverse geocoding?',
          description: 'Clicking the map to find addresses from coordinates is available on the Reverse page.',
        },
      },
      {
        element: isMobile ? '#tour-burger-menu' : '#tour-reverse-pill',
        popover: {
          title: 'Switch to Reverse',
          description: isMobile
            ? 'Tap this menu and select "Reverse" to click anywhere on the map and find nearby addresses.'
            : 'Click "Reverse" to switch. Then click anywhere on the map to find nearby addresses.',
          side: 'bottom',
          align: 'start',
        },
      },
    ],
  })

  driverObj.drive()
}

/** Tour step shown on the Reverse page pointing to nav for geocoding. */
export function showNavTour() {
  const isMobile = window.innerWidth < 1024
  const driverObj = driver({
    showProgress: true,
    animate: true,
    overlayColor: 'black',
    stagePadding: 8,
    stageRadius: 12,
    popoverClass: 'wt-tour-popover',
    onDestroyStarted: () => {
      markTourSeen()
      driverObj.destroy()
    },
    steps: [
      {
        popover: {
          title: 'Welcome to Geocoding Playground',
          description:
            'This is the reverse geocoding page. Click anywhere on the map to find nearby addresses from coordinates.',
        },
      },
      {
        element: isMobile ? '#tour-burger-menu' : '#tour-geocode-pill',
        popover: {
          title: 'Try forward geocoding',
          description: isMobile
            ? 'Tap this menu to switch pages. Try "Geocode" to search addresses by country, city, and street name.'
            : 'Click "Geocode" to search addresses by country, city, and street name.',
          side: 'bottom',
          align: 'start',
        },
      },
    ],
  })

  driverObj.drive()
}
