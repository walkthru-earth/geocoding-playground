import { driver } from 'driver.js'
import 'driver.js/dist/driver.css'

const TOUR_KEY = 'geocode-tour-seen'
const TOUR_VERSION = '2' // bump to re-show after major UI changes

function markTourSeen() {
  localStorage.setItem(TOUR_KEY, TOUR_VERSION)
}

/** Full onboarding tour for the unified Geocode page. */
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
      {
        popover: {
          title: 'Reverse geocoding',
          description:
            'Click anywhere on the map to find nearby addresses. The country and city will auto-fill from the results.',
        },
      },
    ],
  })

  driverObj.drive()
}
