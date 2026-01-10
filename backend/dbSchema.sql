CREATE DATABASE  IF NOT EXISTS `ministerra` /*!40100 DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci */ /*!80016 DEFAULT ENCRYPTION='N' */;
USE `ministerra`;
-- MySQL dump 10.13  Distrib 8.0.34, for Win64 (x86_64)
--
-- Host: 127.0.0.1    Database: ministerra
-- ------------------------------------------------------
-- Server version	8.0.43

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;
SET @MYSQLDUMP_TEMP_LOG_BIN = @@SESSION.SQL_LOG_BIN;
SET @@SESSION.SQL_LOG_BIN= 0;

--
-- GTID state at the beginning of the backup 
--

SET @@GLOBAL.GTID_PURGED=/*!80000 '+'*/ '0c8f88ca-c8d0-11f0-b57d-0242ac120002:1-9524';

--
-- Table structure for table `changes_tracking`
--

DROP TABLE IF EXISTS `changes_tracking`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `changes_tracking` (
  `user` bigint unsigned NOT NULL,
  `prev_mail` varchar(60) DEFAULT NULL,
  `new_mail` varchar(60) DEFAULT NULL,
  `mail_at` timestamp NULL DEFAULT NULL,
  `personals_at` timestamp NULL DEFAULT NULL,
  `changed_age` tinyint DEFAULT '0',
  `changed_name` tinyint DEFAULT '0',
  PRIMARY KEY (`user`),
  KEY `idx_changes_tracking_user` (`user`),
  CONSTRAINT `fk_changes_tracking_user` FOREIGN KEY (`user`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `chat_invites`
--

DROP TABLE IF EXISTS `chat_invites`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `chat_invites` (
  `id` bigint unsigned NOT NULL,
  `chat` bigint unsigned NOT NULL,
  `user` bigint unsigned NOT NULL,
  `user2` bigint unsigned DEFAULT NULL,
  `email` varchar(255) DEFAULT NULL,
  `token` varchar(255) NOT NULL,
  `role` varchar(100) NOT NULL DEFAULT 'member',
  `status` varchar(50) NOT NULL DEFAULT 'pending',
  `created` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_chat_invites_chat` (`chat`),
  KEY `idx_chat_invites_user` (`user`),
  KEY `idx_chat_invites_user2` (`user2`),
  CONSTRAINT `fk_chat_invites_chat` FOREIGN KEY (`chat`) REFERENCES `chats` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_chat_invites_user` FOREIGN KEY (`user`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_chat_invites_user2` FOREIGN KEY (`user2`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `chat_members`
--

DROP TABLE IF EXISTS `chat_members`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `chat_members` (
  `chat` bigint unsigned NOT NULL,
  `id` bigint unsigned NOT NULL,
  `flag` enum('ok','del','fro') NOT NULL DEFAULT 'ok',
  `role` enum('admin','guard','VIP','member','spect','priv') NOT NULL DEFAULT 'member',
  `punish` enum('gag','ban','kick','block') DEFAULT NULL,
  `muted` tinyint NOT NULL DEFAULT '0',
  `at` datetime DEFAULT NULL,
  `who` bigint unsigned DEFAULT NULL,
  `until` timestamp NULL DEFAULT NULL,
  `mess` varchar(255) DEFAULT NULL,
  `pinned` tinyint DEFAULT NULL,
  `seen` bigint NOT NULL DEFAULT '0',
  `last` bigint DEFAULT NULL,
  `changed` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `prev_flag` enum('ok','del','fro') DEFAULT NULL,
  `miss_arc` tinyint NOT NULL DEFAULT '0',
  `archived` tinyint NOT NULL DEFAULT '0',
  `hidden` tinyint NOT NULL DEFAULT '0',
  PRIMARY KEY (`chat`,`id`),
  KEY `idx_chat_members_by_user` (`id`,`flag`,`archived`,`hidden`,`chat`,`seen`),
  KEY `fk_chat_members_who` (`who`),
  CONSTRAINT `fk_chat_members_chat` FOREIGN KEY (`chat`) REFERENCES `chats` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_chat_members_user` FOREIGN KEY (`id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_chat_members_who` FOREIGN KEY (`who`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `chats`
--

DROP TABLE IF EXISTS `chats`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `chats` (
  `id` bigint unsigned NOT NULL,
  `name` varchar(100) DEFAULT NULL,
  `type` enum('private','free','group','VIP') NOT NULL DEFAULT 'private',
  `ended` tinyint DEFAULT '0',
  `v_img` varchar(100) DEFAULT NULL,
  `changed` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `dead` tinyint NOT NULL DEFAULT '0',
  `last_mess` bigint unsigned DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `chats_dead` (`dead`),
  KEY `chats_last_mess_idx` (`last_mess`),
  FULLTEXT KEY `chats_name_fulltext` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `cities`
--

DROP TABLE IF EXISTS `cities`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `cities` (
  `id` int NOT NULL AUTO_INCREMENT,
  `city` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `coords` point DEFAULT NULL,
  `country` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `region` varchar(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `hashID` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `county` varchar(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `part` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `exterID_UNIQUE` (`hashID`)
) ENGINE=InnoDB AUTO_INCREMENT=30 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `comm_rating`
--

DROP TABLE IF EXISTS `comm_rating`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `comm_rating` (
  `comment` bigint unsigned NOT NULL,
  `user` bigint unsigned NOT NULL,
  `mark` int DEFAULT '0',
  `awards` int DEFAULT NULL,
  `changed` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `score` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`comment`,`user`),
  KEY `comm_rating_changed_idx` (`changed`),
  KEY `comm_rating_comment_idx` (`comment`),
  KEY `comm_rating_user_idx` (`user`) /*!80000 INVISIBLE */,
  CONSTRAINT `fk_comm_rating_comment` FOREIGN KEY (`comment`) REFERENCES `comments` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_comm_rating_user` FOREIGN KEY (`user`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `comments`
--

DROP TABLE IF EXISTS `comments`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `comments` (
  `id` bigint unsigned NOT NULL,
  `user` bigint unsigned DEFAULT NULL,
  `event` bigint unsigned DEFAULT NULL,
  `target` bigint unsigned DEFAULT NULL,
  `created` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `content` text,
  `replies` int DEFAULT '0',
  `score` int DEFAULT '0',
  `flag` enum('ok','del') DEFAULT 'ok',
  `changed` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `attach` text,
  PRIMARY KEY (`id`),
  KEY `comments_event_idx` (`event`) /*!80000 INVISIBLE */,
  KEY `comments_target_idx` (`target`) /*!80000 INVISIBLE */,
  KEY `fk_comments_user` (`user`),
  CONSTRAINT `fk_comments_event` FOREIGN KEY (`event`) REFERENCES `events` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_comments_target` FOREIGN KEY (`target`) REFERENCES `comments` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_comments_user` FOREIGN KEY (`user`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `eve_feedback_totals`
--

DROP TABLE IF EXISTS `eve_feedback_totals`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `eve_feedback_totals` (
  `event` bigint unsigned NOT NULL,
  `rating_sum` int NOT NULL DEFAULT '0',
  `rating_count` int NOT NULL DEFAULT '0',
  `praises` json DEFAULT NULL,
  `reprimands` json DEFAULT NULL,
  `aspects` json DEFAULT NULL,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`event`),
  KEY `idx_eve_feedback_totals_event` (`event`),
  CONSTRAINT `fk_eve_feedback_totals_event` FOREIGN KEY (`event`) REFERENCES `events` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `eve_feedback_user`
--

DROP TABLE IF EXISTS `eve_feedback_user`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `eve_feedback_user` (
  `id` bigint unsigned NOT NULL,
  `event` bigint unsigned NOT NULL,
  `user` bigint unsigned NOT NULL,
  `rating` tinyint unsigned DEFAULT NULL,
  `praises` json DEFAULT NULL,
  `reprimands` json DEFAULT NULL,
  `aspects` json DEFAULT NULL,
  `payload` json DEFAULT NULL,
  `comment` varchar(800) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ideas` varchar(800) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_event_user` (`event`,`user`),
  KEY `idx_event` (`event`),
  KEY `idx_user` (`user`),
  KEY `idx_eve_feedback_user_event` (`event`),
  KEY `idx_eve_feedback_user_user` (`user`),
  CONSTRAINT `fk_eve_feedback_user_event` FOREIGN KEY (`event`) REFERENCES `events` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_eve_feedback_user_user` FOREIGN KEY (`user`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `eve_inters`
--

DROP TABLE IF EXISTS `eve_inters`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `eve_inters` (
  `user` bigint unsigned NOT NULL,
  `event` bigint unsigned NOT NULL,
  `changed` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `inter` enum('sur','may','del','int') DEFAULT 'sur',
  `priv` enum('pub','lin','inv','tru','own') DEFAULT 'pub',
  PRIMARY KEY (`user`,`event`),
  KEY `eve_inters_user_idx` (`user`) /*!80000 INVISIBLE */,
  KEY `eve_inters_changed_idx` (`changed`),
  KEY `fk_eve_inters_event` (`event`),
  CONSTRAINT `fk_eve_inters_event` FOREIGN KEY (`event`) REFERENCES `events` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_eve_inters_user` FOREIGN KEY (`user`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `eve_invites`
--

DROP TABLE IF EXISTS `eve_invites`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `eve_invites` (
  `event` bigint unsigned NOT NULL,
  `user` bigint unsigned NOT NULL,
  `user2` bigint unsigned NOT NULL,
  `email` varchar(100) DEFAULT NULL,
  `note` varchar(200) DEFAULT NULL,
  `flag` enum('ok','acc','ref','del') NOT NULL DEFAULT 'ok',
  `created` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`user2`,`user`,`event`),
  KEY `eve_invites_event_idx` (`user`),
  KEY `eve_invites_user_idx` (`user2`),
  KEY `fk_eve_invites_event` (`event`),
  CONSTRAINT `fk_eve_invites_event` FOREIGN KEY (`event`) REFERENCES `events` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_eve_invites_user` FOREIGN KEY (`user`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_eve_invites_user2` FOREIGN KEY (`user2`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `eve_rating`
--

DROP TABLE IF EXISTS `eve_rating`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `eve_rating` (
  `event` bigint unsigned NOT NULL,
  `user` bigint unsigned NOT NULL,
  `mark` int DEFAULT '0',
  `awards` int DEFAULT NULL,
  `changed` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `score` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`event`,`user`),
  KEY `eve_rating_changed_idx` (`changed`),
  KEY `eve_rating_event_idx` (`event`) /*!80000 INVISIBLE */,
  KEY `eve_rating_user_idx` (`user`),
  CONSTRAINT `fk_eve_rating_event` FOREIGN KEY (`event`) REFERENCES `events` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_eve_rating_user` FOREIGN KEY (`user`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `events`
--

DROP TABLE IF EXISTS `events`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `events` (
  `id` bigint unsigned NOT NULL,
  `created` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `owner` bigint unsigned DEFAULT NULL,
  `title` varchar(300) DEFAULT NULL,
  `starts` datetime DEFAULT NULL,
  `ends` datetime DEFAULT NULL,
  `shortDesc` varchar(1000) DEFAULT NULL,
  `detail` text,
  `place` varchar(100) DEFAULT NULL,
  `location` varchar(100) DEFAULT NULL,
  `part` varchar(100) DEFAULT NULL,
  `cityID` int DEFAULT NULL,
  `meetHow` varchar(1000) DEFAULT NULL,
  `meetWhen` datetime DEFAULT NULL,
  `fee` varchar(1000) DEFAULT NULL,
  `takeWith` varchar(1000) DEFAULT NULL,
  `contacts` varchar(500) DEFAULT NULL,
  `coords` point DEFAULT NULL,
  `district` varchar(45) DEFAULT NULL,
  `type` varchar(3) DEFAULT NULL,
  `links` varchar(200) DEFAULT NULL,
  `organizer` varchar(300) DEFAULT NULL,
  `basiVers` int DEFAULT '1',
  `detaVers` int DEFAULT '1',
  `surely` int DEFAULT '0',
  `maybe` int DEFAULT '0',
  `interrested` int DEFAULT '0',
  `score` int DEFAULT '0',
  `flag` enum('ok','new','can','del','pas') DEFAULT 'ok',
  `comments` int DEFAULT '0',
  `imgVers` int DEFAULT '0',
  `changed` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `priv` enum('pub','lin','inv','tru') DEFAULT NULL,
  `live_until` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `events_owner_idx` (`owner`),
  KEY `events_starts_idx` (`starts`),
  KEY `events_flag_idx` (`flag`),
  KEY `events_live_until_idx` (`live_until`),
  KEY `idx_events_city` (`cityID`),
  FULLTEXT KEY `events_title_fulltext` (`title`),
  CONSTRAINT `fk_events_city` FOREIGN KEY (`cityID`) REFERENCES `cities` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_events_owner` FOREIGN KEY (`owner`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `fro_users`
--

DROP TABLE IF EXISTS `fro_users`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `fro_users` (
  `id` bigint unsigned NOT NULL,
  `flag` enum('ok','pri','fro','unf','del','don') DEFAULT 'ok',
  `created` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `email` varchar(60) NOT NULL,
  `pass` varchar(65) NOT NULL,
  `first` varchar(45) NOT NULL,
  `last` varchar(45) NOT NULL,
  `gender` varchar(6) DEFAULT NULL,
  `birth` datetime DEFAULT NULL,
  `cities` varchar(100) DEFAULT NULL,
  `address` varchar(45) DEFAULT NULL,
  `score` int DEFAULT '0',
  `basics` varchar(255) DEFAULT '',
  `indis` varchar(30) DEFAULT '',
  `groups` varchar(250) DEFAULT '',
  `favs` varchar(200) DEFAULT NULL,
  `exps` varchar(200) DEFAULT NULL,
  `status` varchar(100) DEFAULT 'notVerified',
  `basiVers` int DEFAULT '0',
  `imgVers` int NOT NULL DEFAULT '0',
  `changed` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `shortDesc` varchar(500) DEFAULT NULL,
  `priv` enum('pub','lin','tru','own','ind') DEFAULT 'pub',
  `askPriv` tinyint DEFAULT '0',
  `defPriv` enum('pub','lin','tru','own','ind') DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `user_flag_idx` (`flag`),
  KEY `user_email_idx` (`email`),
  FULLTEXT KEY `user_name_fulltext` (`first`,`last`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `last_seen`
--

DROP TABLE IF EXISTS `last_seen`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `last_seen` (
  `user` bigint unsigned NOT NULL,
  `mess` bigint DEFAULT NULL,
  `alert` bigint DEFAULT NULL,
  PRIMARY KEY (`user`),
  KEY `idx_last_seen_user` (`user`),
  CONSTRAINT `fk_last_seen_user` FOREIGN KEY (`user`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `logins`
--

DROP TABLE IF EXISTS `logins`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `logins` (
  `user` bigint unsigned NOT NULL,
  `last_seen` datetime DEFAULT CURRENT_TIMESTAMP,
  `count` int DEFAULT '0',
  `0_3` int DEFAULT '0',
  `3_6` int DEFAULT '0',
  `6_9` int DEFAULT '0',
  `9_12` int DEFAULT '0',
  `12_15` int DEFAULT '0',
  `15_18` int DEFAULT '0',
  `18_21` int DEFAULT '0',
  `21_24` int DEFAULT '0',
  `mon` int DEFAULT '0',
  `tue` int DEFAULT '0',
  `wed` int DEFAULT '0',
  `thu` int DEFAULT '0',
  `fri` int DEFAULT '0',
  `sat` int DEFAULT '0',
  `sun` int DEFAULT '0',
  `desktop` int DEFAULT '0',
  `mobile` int DEFAULT '0',
  `Android` int DEFAULT '0',
  `Windows` int DEFAULT '0',
  `iOS` int DEFAULT '0',
  `ip_addresses` json DEFAULT NULL,
  `inactive` tinyint DEFAULT NULL,
  PRIMARY KEY (`user`),
  KEY `logins_inactive_idx` (`inactive`),
  CONSTRAINT `fk_logins_user` FOREIGN KEY (`user`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `mess_rating`
--

DROP TABLE IF EXISTS `mess_rating`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `mess_rating` (
  `message` bigint unsigned NOT NULL,
  `user` bigint unsigned NOT NULL,
  `changed` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `mark` int DEFAULT '0',
  `awards` int DEFAULT NULL,
  PRIMARY KEY (`message`,`user`),
  KEY `m_rating_message_idx` (`message`) /*!80000 INVISIBLE */,
  KEY `m_rating_changed_idx` (`changed`),
  KEY `fk_mess_rating_user` (`user`),
  CONSTRAINT `fk_mess_rating_message` FOREIGN KEY (`message`) REFERENCES `messages` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_mess_rating_user` FOREIGN KEY (`user`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `messages`
--

DROP TABLE IF EXISTS `messages`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `messages` (
  `id` bigint unsigned NOT NULL,
  `created` datetime DEFAULT CURRENT_TIMESTAMP,
  `chat` bigint unsigned DEFAULT NULL,
  `user` bigint unsigned DEFAULT NULL,
  `content` text,
  `attach` text,
  `score` int DEFAULT NULL,
  `changed` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `flag` enum('ok','del') DEFAULT 'ok',
  PRIMARY KEY (`id`),
  KEY `idx_messages_chat_pagination` (`chat`,`flag`,`id` DESC),
  KEY `idx_messages_user` (`user`),
  CONSTRAINT `fk_messages_chat` FOREIGN KEY (`chat`) REFERENCES `chats` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_messages_user` FOREIGN KEY (`user`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `miscellaneous`
--

DROP TABLE IF EXISTS `miscellaneous`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `miscellaneous` (
  `last_server_start` datetime DEFAULT NULL,
  `id` int NOT NULL AUTO_INCREMENT,
  `last_daily_recalc` datetime DEFAULT NULL,
  `last_arc_mess_id` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `rem_comments`
--

DROP TABLE IF EXISTS `rem_comments`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `rem_comments` (
  `id` bigint unsigned NOT NULL,
  `user` bigint unsigned DEFAULT NULL,
  `event` bigint unsigned DEFAULT NULL,
  `target` bigint unsigned DEFAULT NULL,
  `created` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `content` text,
  `replies` int DEFAULT '0',
  `score` int DEFAULT '0',
  `flag` enum('ok','del') DEFAULT 'ok',
  `changed` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `attach` text,
  PRIMARY KEY (`id`),
  KEY `comments_event_idx` (`event`) /*!80000 INVISIBLE */,
  KEY `comments_target_idx` (`target`) /*!80000 INVISIBLE */
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `rem_events`
--

DROP TABLE IF EXISTS `rem_events`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `rem_events` (
  `id` bigint unsigned NOT NULL,
  `created` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `owner` bigint unsigned DEFAULT NULL,
  `title` varchar(300) DEFAULT NULL,
  `starts` datetime DEFAULT NULL,
  `ends` datetime DEFAULT NULL,
  `shortDesc` varchar(1000) DEFAULT NULL,
  `detail` text,
  `place` varchar(100) DEFAULT NULL,
  `location` varchar(100) DEFAULT NULL,
  `part` varchar(100) DEFAULT NULL,
  `cityID` int DEFAULT NULL,
  `meetHow` varchar(1000) DEFAULT NULL,
  `meetWhen` datetime DEFAULT NULL,
  `fee` varchar(1000) DEFAULT NULL,
  `takeWith` varchar(1000) DEFAULT NULL,
  `contacts` varchar(500) DEFAULT NULL,
  `coords` point DEFAULT NULL,
  `district` varchar(45) DEFAULT NULL,
  `type` int DEFAULT NULL,
  `links` varchar(200) DEFAULT NULL,
  `organizer` varchar(300) DEFAULT NULL,
  `basiVers` int DEFAULT '1',
  `detaVers` int DEFAULT '1',
  `surely` int DEFAULT '0',
  `maybe` int DEFAULT '0',
  `interrested` int DEFAULT '0',
  `score` int DEFAULT '0',
  `flag` enum('ok','new','can','del','pas','don') DEFAULT 'ok',
  `comments` int DEFAULT '0',
  `imgVers` varchar(5) DEFAULT '0',
  `changed` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `priv` enum('pub','lin','inv','tru') DEFAULT NULL,
  `live_until` datetime DEFAULT NULL,
  `eventscol` varchar(45) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `events_owner_idx` (`owner`),
  KEY `events_starts_idx` (`starts`),
  KEY `events_flag_idx` (`flag`),
  KEY `events_live_until_idx` (`live_until`),
  FULLTEXT KEY `events_title_fulltext` (`title`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `rem_users`
--

DROP TABLE IF EXISTS `rem_users`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `rem_users` (
  `id` bigint unsigned NOT NULL,
  `flag` enum('ok','pri','fro','unf','del','don') DEFAULT 'ok',
  `created` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `email` varchar(60) NOT NULL,
  `pass` varchar(65) NOT NULL,
  `first` varchar(45) NOT NULL,
  `last` varchar(45) NOT NULL,
  `gender` varchar(6) DEFAULT NULL,
  `birth` datetime DEFAULT NULL,
  `cities` varchar(100) DEFAULT NULL,
  `address` varchar(45) DEFAULT NULL,
  `score` int DEFAULT '0',
  `basics` varchar(255) DEFAULT '',
  `indis` varchar(30) DEFAULT '',
  `groups` varchar(250) DEFAULT '',
  `favs` varchar(200) DEFAULT NULL,
  `exps` varchar(200) DEFAULT NULL,
  `status` varchar(100) DEFAULT 'notVerified',
  `basiVers` int DEFAULT '0',
  `imgVers` int NOT NULL DEFAULT '0',
  `changed` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `shortDesc` varchar(500) DEFAULT NULL,
  `priv` enum('pub','lin','tru','own','ind') DEFAULT 'pub',
  `askPriv` tinyint DEFAULT '0',
  `defPriv` enum('pub','lin','tru','own','ind') DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `user_flag_idx` (`flag`),
  KEY `user_email_idx` (`email`),
  FULLTEXT KEY `user_name_fulltext` (`first`,`last`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `reports`
--

DROP TABLE IF EXISTS `reports`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `reports` (
  `id` bigint unsigned NOT NULL,
  `type` varchar(45) DEFAULT NULL,
  `target` bigint unsigned DEFAULT NULL,
  `user` bigint unsigned DEFAULT NULL,
  `reason` varchar(50) DEFAULT NULL,
  `severity` int DEFAULT NULL,
  `message` text,
  PRIMARY KEY (`id`),
  KEY `fk_reports_user` (`user`),
  CONSTRAINT `fk_reports_user` FOREIGN KEY (`user`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `rjwt_tokens`
--

DROP TABLE IF EXISTS `rjwt_tokens`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `rjwt_tokens` (
  `user` bigint unsigned NOT NULL,
  `device` varchar(21) NOT NULL,
  `token` varchar(250) DEFAULT NULL,
  `created` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `print` varchar(100) DEFAULT NULL,
  PRIMARY KEY (`user`,`device`),
  CONSTRAINT `fk_rjwt_tokens_user` FOREIGN KEY (`user`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `testing`
--

DROP TABLE IF EXISTS `testing`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `testing` (
  `user` bigint unsigned DEFAULT NULL,
  `body` text,
  `created` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `path` varchar(255) DEFAULT NULL,
  `agent` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `user_alerts`
--

DROP TABLE IF EXISTS `user_alerts`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `user_alerts` (
  `id` bigint unsigned NOT NULL,
  `what` enum('comment','reply','comm_rating','eve_rating','user_rating','invite','interest','link','accept') DEFAULT NULL,
  `user` bigint unsigned DEFAULT NULL,
  `target` bigint unsigned DEFAULT NULL,
  `data` json DEFAULT NULL,
  `created` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `flag` enum('acc','ref','ok') DEFAULT 'ok',
  PRIMARY KEY (`id`),
  KEY `user_alerts_user_idx` (`user`) /*!80000 INVISIBLE */,
  KEY `idx_user_alerts_user` (`user`),
  CONSTRAINT `fk_user_alerts_user` FOREIGN KEY (`user`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `user_blocks`
--

DROP TABLE IF EXISTS `user_blocks`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `user_blocks` (
  `user` bigint unsigned NOT NULL,
  `user2` bigint unsigned NOT NULL,
  `who` tinyint NOT NULL,
  `created` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`user`,`user2`),
  KEY `fk_user_blocks_user2` (`user2`),
  CONSTRAINT `fk_user_blocks_user` FOREIGN KEY (`user`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_user_blocks_user2` FOREIGN KEY (`user2`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `user_devices`
--

DROP TABLE IF EXISTS `user_devices`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `user_devices` (
  `id` bigint unsigned NOT NULL,
  `user_id` bigint unsigned NOT NULL,
  `device_id` varchar(32) NOT NULL,
  `salt` varchar(64) NOT NULL,
  `device_key` varchar(64) DEFAULT NULL,
  `fingerprint_hash` varchar(32) DEFAULT NULL,
  `name` varchar(100) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `last_seen` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `last_purge_sync` timestamp NULL DEFAULT NULL,
  `is_revoked` tinyint(1) DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_user_device` (`user_id`,`device_id`),
  KEY `idx_user` (`user_id`),
  KEY `idx_last_seen` (`last_seen`),
  KEY `idx_user_devices_user_id` (`user_id`),
  CONSTRAINT `fk_user_devices_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `user_links`
--

DROP TABLE IF EXISTS `user_links`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `user_links` (
  `user` bigint unsigned NOT NULL,
  `user2` bigint unsigned NOT NULL,
  `note` varchar(200) DEFAULT NULL,
  `note2` varchar(200) DEFAULT NULL,
  `link` enum('ok','req','ref','tru','del') NOT NULL DEFAULT 'req',
  `created` timestamp NULL DEFAULT NULL,
  `who` tinyint DEFAULT NULL,
  `message` varchar(200) DEFAULT NULL,
  `changed` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user`,`user2`),
  KEY `user_links_user_idx` (`user`),
  KEY `user_links_user2_idx` (`user2`),
  KEY `user_links_changed_idx` (`changed`),
  CONSTRAINT `fk_user_links_user` FOREIGN KEY (`user`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_user_links_user2` FOREIGN KEY (`user2`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `user_rating`
--

DROP TABLE IF EXISTS `user_rating`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `user_rating` (
  `user` bigint unsigned NOT NULL,
  `user2` bigint unsigned NOT NULL,
  `mark` int NOT NULL DEFAULT '0',
  `changed` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `awards` int DEFAULT NULL,
  `score` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`user`,`user2`),
  KEY `user_rating user_idx` (`user`),
  KEY `user_rating_changed_idx` (`changed`),
  KEY `fk_user_rating_user2` (`user2`),
  CONSTRAINT `fk_user_rating_user` FOREIGN KEY (`user`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_user_rating_user2` FOREIGN KEY (`user2`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `users`
--

DROP TABLE IF EXISTS `users`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `users` (
  `id` bigint unsigned NOT NULL,
  `flag` enum('ok','pri','fro','unf','del') DEFAULT 'ok',
  `created` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `email` varchar(60) NOT NULL,
  `pass` varchar(65) NOT NULL,
  `first` varchar(45) DEFAULT NULL,
  `last` varchar(45) DEFAULT NULL,
  `gender` varchar(6) DEFAULT NULL,
  `birth` datetime DEFAULT NULL,
  `cities` varchar(100) DEFAULT NULL,
  `address` varchar(45) DEFAULT NULL,
  `score` int DEFAULT '0',
  `basics` varchar(255) DEFAULT '',
  `indis` varchar(30) DEFAULT '',
  `groups` varchar(250) DEFAULT '',
  `favs` varchar(200) DEFAULT NULL,
  `exps` varchar(200) DEFAULT NULL,
  `status` enum('verifyMail','user','newUser','unintroduced') DEFAULT 'verifyMail',
  `imgVers` int DEFAULT '0',
  `basiVers` int NOT NULL DEFAULT '0',
  `changed` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `shortDesc` varchar(500) DEFAULT NULL,
  `priv` enum('pub','lin','tru','own','ind') DEFAULT 'pub',
  `defPriv` enum('pub','lin','tru','own','ind') DEFAULT NULL,
  `askPriv` tinyint DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_users_email` (`email`),
  KEY `user_flag_idx` (`flag`),
  KEY `user_email_idx` (`email`),
  FULLTEXT KEY `user_name_fulltext` (`first`,`last`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
SET @@SESSION.SQL_LOG_BIN = @MYSQLDUMP_TEMP_LOG_BIN;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-01-04 18:23:27
