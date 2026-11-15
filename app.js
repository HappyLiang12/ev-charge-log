import { normalizeCar } from './logic.js';
import { initFamily } from './family.js';
import { initOwner } from './owner.js';

const config = window.APP_CONFIG || {};
const apiUrl = typeof config.API_URL === 'string' ? config.API_URL.trim() : '';
const params = new URLSearchParams(window.location.search);
const familyView = document.getElementById('familyView');
const ownerView = document.getElementById('ownerView');
const setupView = document.getElementById('setupView');
const ownerMode = params.has('owner');
const carParam = params.get('car');
const car = carParam && carParam !== 'unassigned'
  ? normalizeCar({ id: carParam, name: carParam })
  : null;

if (ownerMode) {
  ownerView.hidden = false;
  initOwner({ apiUrl });
} else if (car) {
  familyView.hidden = false;
  initFamily({ apiUrl, carId: car.id });
} else {
  setupView.hidden = false;
}
