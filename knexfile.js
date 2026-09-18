require("dotenv").config();

module.exports = {
  development: {
    client: "mysql2",
    connection: {
      host: process.env.DB_HOST || "127.0.0.1",
      port: process.env.DB_PORT || 3306,
      database: process.env.DB_NAME || "food_delivery",
      user: process.env.DB_USER || "root",
      password: process.env.DB_PASSWORD || "",
    },
    migrations: {
      directory: "./src/migrations",
      tableName: "knex_migrations",
    },
    pool: { min: 2, max: 10 },
  },
  production: {
    client: "mysql2",
    connection: {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl: { rejectUnauthorized: false },
    },
    migrations: {
      directory: "./src/migrations",
      tableName: "knex_migrations",
    },
    pool: { min: 2, max: 10 },
  },
};
