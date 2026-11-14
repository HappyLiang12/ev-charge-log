import { normalizeCar } from './logic.js';
import { initFamily } from './family.js';

const config = window.APP_CONFIG || {};
const apiUrl = typeof config.API_URL === 'string' ? config.API_URL.trim() : '';
const params = new URLSearchParams(window.location.search);
const familyView = document.getElementById('familyView');
const setupView = document.getElementById('setupView');
const car = params.get('car') ? normalizeCar({ id: params.get('car'), name: params.get('car') }) : null;

if (car) {
  familyView.hidden = false;
  initFamily({ apiUrl, carId: car.id });
} else {
  setupView.hidden = false;
}
