require("dotenv").config();
const app = require("./app");

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`API listening on port ${PORT} [${process.env.NODE_ENV || "development"}]`);
  // Sends scheduled notification campaigns when they come due. Started here, not in app.js, so tests
  // and tools that load the app never run it; the API runs as one PM2 instance, so one timer is enough.
  require("./services/campaign.service").startScheduler();
  // Safety net for orders waiting on a rider (accepted, no one free yet): the event triggers do the work, this catches misses.
  require("./services/riderDispatch.service").startTick();
});
