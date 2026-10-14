-- Security questions support
CREATE TABLE IF NOT EXISTS security_questions (
  id INT PRIMARY KEY,
  question_text VARCHAR(255) NOT NULL
) ENGINE=InnoDB;

INSERT INTO security_questions (id, question_text) VALUES
  (1, 'What was the name of your first school?'),
  (2, 'What was your childhood nickname?'),
  (3, 'What was the name of your first pet?'),
  (4, 'What was the name of your childhood best friend?'),
  (5, 'What is the name of a memorable place from your childhood?'),
  (6, 'What was your favorite childhood subject?')
  ON DUPLICATE KEY UPDATE question_text = VALUES(question_text);

CREATE TABLE IF NOT EXISTS user_security_answers (
  user_id INT NOT NULL,
  question_id INT NOT NULL,
  answer_hash VARCHAR(255) NOT NULL,
  PRIMARY KEY (user_id, question_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (question_id) REFERENCES security_questions(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS password_recovery_attempts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(100) NOT NULL,
  ip VARCHAR(64) NOT NULL,
  attempted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_email_time (email, attempted_at),
  INDEX idx_ip_time (ip, attempted_at)
) ENGINE=InnoDB;
