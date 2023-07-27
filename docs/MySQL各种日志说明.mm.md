# MySQL各种日志详解
## 二进制日志(binlog)
### binlog日志用于记录所有更新了数据或者已经潜在更新了数据（例如，没有匹配任何行的一个DELETE）的所有语句。语句以“事件”的形式保存，它描述数据更改。
### 作用
- 1.主从复制：MySQL主从复制在Master端开启binlog，Master把它的二进制日志传递给slaves来达到master-slave数据一致性的目的
- 2.数据恢复：通过myslbinlog工具恢复数据
### 注意
- binlog 只会记录修改数据库操作的语句(update、delete、drop等)，不会记录查询语句(select、show等)
- binlog会重写日志中的密码。保证不以纯文本的形式出现
- MySQL 8 之后的版本可以选择对 binlog 进行加密
- 具体的写入时间：在事务提交的时候，数据库会把 binlog cache 写入 binlog 文件中，但并没有执行fsync()操作，即只将文件内容写入到 OS 缓存中。随后根据配置判断是否执行 fsync。
- 具体的写入时间：在事务提交的时候，数据库会把 binlog cache 写入 binlog 文件中，但并没有执行fsync()操作，即只将文件内容写入到 OS 缓存中。随后根据配置判断是否执行 fsync。
- 删除时间：保持时间由参数expire_logs_days配置，也就是说对于非活动的日志文件，在生成时间超过expire_logs_days配置的天数之后，会被自动删除。
### 常用命令
- binlog 的配置信息：show variables like '%log_bin%';
- binlog 的配置信息：show variables like '%log_bin%';
- 日志的文件列表：show binary logs;
- 当前日志的写入状态：show master status;
- 清空 binlog 日志：reset master;
### 格式
#### Row格式
- Row 格式仅保存记录被修改细节，不记录 sql 语句上下文相关信息。新版本的 MySQL 默认是 Row 格式。
- 优点：能非常清晰的记录下每行数据的修改细节，不需要记录上下文相关信息，因此不会发生某些特定情况下的存储过程、函数或者触发器的调用触发无法被正确复制的问题，任何情况都可以被复制，且能加快从库重放日志的效率，保证从库数据的一致性
- 缺点：由于所有的执行的语句在日志中都将以每行记录的修改细节来记录，因此，可能会产生大量的日志内容，干扰内容也较多。比如一条 update 语句，如修改多条记录，则 binlog 中每一条修改都会有记录，这样造成 binlog 日志量会很大，特别是当执行alter table之类的语句的时候，由于表结构修改，每条记录都发生改变，那么该表每一条记录都会记录到日志中，实际等于重建了表。
#### Statement格式
- 每一条会修改数据的 sql 都会记录在 binlog 中。
- 优点：只需要记录执行语句的细节和上下文环境，避免了记录每一行的变化，在一些修改记录较多的情况下相比 Row 格式能大大减少 binlog 日志量，节约 IO，提高性能。
## 重做日志(redo log)
## 回滚日志(undo log)
## 中继日志(relaylog)