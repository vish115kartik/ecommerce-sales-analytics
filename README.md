# E-Commerce Sales Analytics with Hadoop MapReduce

A college-level batch analytics application for supplied e-commerce CSV files. Python validates and stages records, HDFS stores each run's inputs and outputs, three Java MapReduce jobs calculate aggregates/rankings/joins, and Streamlit presents only results read from a successful Hadoop run. The included data is deterministic and synthetic; it is not retailer data.

## Environment Status

Implementation started in this Windows workspace with Python 3.14.3 and Java 25.0.1. OpenJDK 11.0.30 and Maven 3.9.15 have since been installed into the user profile. The Hadoop 3.3.6 archive is downloaded to `C:\Users\dipes\Downloads\hadoop-3.3.6.tar.gz` and its SHA-512 matches the Apache sidecar. WSL has no registered Linux distribution and `wsl` reports `Class not registered`, so Hadoop/HDFS cannot run until WSL is repaired. An IDE-produced Java 25 JAR was replaced by the verified Maven Java 11 build. Therefore no Hadoop job, HDFS upload, or end-to-end analytics run is claimed as successful. The real-Hadoop integration test is included and skipped until a configured Hadoop environment is available.

The supported demonstration target below is Ubuntu 22.04 under WSL2, OpenJDK 11, Apache Hadoop 3.3.6 in pseudo-distributed mode, Python 3.10+, and Maven 3.6+. Those installation commands are provided for reproducibility but were not executable in the current environment.

## Features

- Upload and validate `orders.csv` and optional `products.csv`; show accepted/rejected/total rows and row-level issues.
- Stage validated rows and selected date/region/category filters to a unique HDFS run directory.
- Execute three actual Hadoop jobs: sales aggregation, globally sorted product rankings, and a tagged product lookup join.
- Calculate gross revenue, units, exact distinct order IDs, average order value, month/category/region aggregates, and optional profit.
- Display results only after every job exits successfully and its HDFS outputs parse correctly.
- Export displayed tables as CSV and retain run status, timestamps, output paths, stdout, and stderr in local run records.
- Generate deterministic labelled synthetic datasets, including datasets of 100,000 or more transaction lines.

There is no Pandas dependency in the analytics path. Python performs schema/value validation, row filtering, subprocess orchestration, output decoding, and presentation. All business aggregations, global ranking, and profit aggregation are implemented in Java MapReduce.

## Project Layout

```text
app.py
config/config.yaml
data/sample/                 generated 300-line synthetic sample
docs/                        architecture, dataset dictionary, viva notes
hadoop-jobs/                  Maven project and Java MapReduce jobs
scripts/                      data generator and environment/demo scripts
src/ingestion/                validation and normalization
src/hadoop/                   HDFS client, job runner, output reader
src/orchestration.py           isolated end-to-end run controller
tests/                         unit tests and opt-in Hadoop integration test
```

## Dataset and Metrics

Required transaction fields are `order_id`, `order_date`, `customer_id`, `product_id`, `quantity`, `unit_price`, `region`, and `category`. `products.csv` requires `product_id`, `product_name`, and `category`; `unit_cost` is optional but, when that column is present, every accepted product row must have a valid cost.

Dates accept `YYYY-MM-DD`, `MM/DD/YYYY`, or `DD-MM-YYYY` and are normalized to ISO dates. Quantity must be a positive ASCII integer. Prices and costs must be non-negative and have at most two decimal places. CSV quoting, commas, and escaped quote characters are handled by Python's CSV parser and the Java CSV parser. Embedded line breaks in fields are rejected because the Hadoop jobs use line-oriented `TextInputFormat`.

Formulas:

- Revenue: `quantity × unit_price`, accumulated in integer cents by Java reducers.
- Units sold: sum of transaction quantities.
- Distinct orders: cardinality of the exact order-ID set within each aggregation group; this is not transaction-line count.
- Average order value: total revenue divided by the distinct order count, rounded half-up to cents by the Java aggregation reducer.
- Profit (only with a complete `unit_cost` lookup): `quantity × (unit_price − unit_cost)`, accumulated by the Java join reducer.

When no product lookup is uploaded, the pipeline builds a minimal join lookup from the accepted transactions (`product_name = product_id`, category from each transaction, no unit cost). An uploaded lookup with unmatched product IDs produces explicit `MISSING` join rows. See [docs/dataset_dictionary.md](docs/dataset_dictionary.md) for input and output schemas.

## Setup: Ubuntu 22.04 on WSL2

Because this host returned `Class not registered` for `wsl --status` and has no configured Linux distribution, install/repair WSL before proceeding. In an elevated Windows PowerShell, run:

```powershell
wsl --install --no-distribution
wsl --install -d Ubuntu-22.04
```

Restart Windows if prompted, launch **Ubuntu 22.04** from the Start menu to create its Linux user, then confirm it is WSL2 from PowerShell:

```powershell
wsl --list --verbose
wsl --set-version Ubuntu-22.04 2
```

If `wsl --install` still reports `Class not registered`, enable the Windows features **Windows Subsystem for Linux** and **Virtual Machine Platform**, reboot, then install/update the WSL app from Microsoft Store and repeat the commands. These system changes were not run from this workspace.

Run the following in an Ubuntu 22.04 WSL terminal. Keep the repository on the Linux filesystem for Hadoop/Maven performance when possible; if using this workspace from Windows, it is available as `/mnt/f/BDA`.

1. Install Java, Maven, Python, and SSH:

   ```bash
   sudo apt update
   sudo apt install -y openjdk-11-jdk maven python3 python3-venv python3-pip openssh-server curl
   java -version
   mvn -version
   ```

2. Download Hadoop 3.3.6 and configure environment variables:

   ```bash
   cd "$HOME"
    # Reuse the verified Windows download, or use curl if it is not available.
    cp /mnt/c/Users/<WindowsUser>/Downloads/hadoop-3.3.6.tar.gz "$HOME/" \
       || curl -fLO https://archive.apache.org/dist/hadoop/common/hadoop-3.3.6/hadoop-3.3.6.tar.gz
   tar -xzf hadoop-3.3.6.tar.gz
   cat >> "$HOME/.bashrc" <<'EOF'
   export JAVA_HOME=/usr/lib/jvm/java-11-openjdk-amd64
   export HADOOP_HOME="$HOME/hadoop-3.3.6"
   export HADOOP_CONF_DIR="$HADOOP_HOME/etc/hadoop"
   export HADOOP_MAPRED_HOME="$HADOOP_HOME"
   export PATH="$PATH:$HADOOP_HOME/bin:$HADOOP_HOME/sbin"
   EOF
   source "$HOME/.bashrc"
   printf '\nexport JAVA_HOME=%s\n' "$JAVA_HOME" >> "$HADOOP_CONF_DIR/hadoop-env.sh"
   hadoop version
   ```

3. Enable passwordless localhost SSH for Hadoop startup scripts:

   ```bash
   sudo service ssh start
   ssh-keygen -t rsa -P '' -f "$HOME/.ssh/id_rsa"
   cat "$HOME/.ssh/id_rsa.pub" >> "$HOME/.ssh/authorized_keys"
   chmod 600 "$HOME/.ssh/authorized_keys"
   ssh -o StrictHostKeyChecking=accept-new localhost true
   ```

4. Configure pseudo-distributed HDFS and YARN. Replace the XML property blocks in the indicated files (preserve the surrounding `<configuration>` tags):

   `core-site.xml`:

   ```xml
   <property><name>fs.defaultFS</name><value>hdfs://localhost:9000</value></property>
   ```

   `hdfs-site.xml`:

   ```xml
   <property><name>dfs.replication</name><value>1</value></property>
   <property><name>dfs.namenode.name.dir</name><value>file:///home/REPLACE_WITH_LINUX_USER/hadoop-data/name</value></property>
   <property><name>dfs.datanode.data.dir</name><value>file:///home/REPLACE_WITH_LINUX_USER/hadoop-data/data</value></property>
   ```

   `mapred-site.xml`:

   ```xml
   <property><name>mapreduce.framework.name</name><value>yarn</value></property>
   <property><name>mapreduce.application.classpath</name><value>$HADOOP_MAPRED_HOME/share/hadoop/mapreduce/*:$HADOOP_MAPRED_HOME/share/hadoop/mapreduce/lib/*</value></property>
   ```

   `yarn-site.xml`:

   ```xml
   <property><name>yarn.nodemanager.aux-services</name><value>mapreduce_shuffle</value></property>
   <property><name>yarn.resourcemanager.hostname</name><value>localhost</value></property>
   ```

   Replace `REPLACE_WITH_LINUX_USER` with the output of `whoami`. Create the local data folders and format the NameNode only on a fresh installation:

   ```bash
   mkdir -p "$HOME/hadoop-data/name" "$HOME/hadoop-data/data"
   hdfs namenode -format
   start-dfs.sh
   start-yarn.sh
   jps
   hdfs dfs -mkdir -p "/user/$USER" /bda_sales
   printf 'hdfs smoke test\n' > /tmp/bda-hdfs-smoke.txt
   hdfs dfs -put -f /tmp/bda-hdfs-smoke.txt /user/"$USER"/
   hdfs dfs -cat /user/"$USER"/bda-hdfs-smoke.txt
   ```

5. In the repository root, create the Python environment, install dependencies, compile the JAR, and run tests:

   ```bash
   cd /mnt/f/BDA  # or the Linux-filesystem checkout
   python3 -m venv .venv
   source .venv/bin/activate
   python -m pip install --upgrade pip
   python -m pip install -r requirements.txt
   mvn -f hadoop-jobs/pom.xml clean package
   python scripts/generate_dataset.py --rows 300 --output-dir data/sample
   python -m pytest tests -q
   ```

6. Run a real aggregation job manually once. Use a fresh output path because Hadoop will not overwrite an existing output directory:

   ```bash
   RUN_ID="manual-$(date +%Y%m%d%H%M%S)"
   hdfs dfs -mkdir -p "/bda_sales/runs/$RUN_ID/input"
   hdfs dfs -put data/sample/orders.csv "/bda_sales/runs/$RUN_ID/input/orders.csv"
   hadoop jar hadoop-jobs/target/ecommerce-sales-analytics-1.0.0.jar \
     com.bda.sales.SalesAggregation \
     "/bda_sales/runs/$RUN_ID/input/orders.csv" \
     "/bda_sales/runs/$RUN_ID/output/aggregation"
   hdfs dfs -cat "/bda_sales/runs/$RUN_ID/output/aggregation/part-*" | head
   ```

7. Start the app in that same WSL environment so its `hadoop` command uses the configured HDFS:

   ```bash
   streamlit run app.py --server.address 0.0.0.0
   ```

   Open `http://localhost:8501` in the Windows browser. Choose the sample or upload CSVs, set date/region/category filters, then select **Run Hadoop MapReduce**. Each selection is staged as a unique input and causes fresh Hadoop jobs to run; charts never calculate fallback analytics locally.

## Build, Tests, and Larger Data

```bash
mvn -f hadoop-jobs/pom.xml clean package
python -m pytest tests -q
BDA_RUN_HADOOP_INTEGRATION=1 python -m pytest tests/test_hadoop_integration.py -q
python scripts/generate_dataset.py --rows 100000 --output-dir data/generated/100k
```

The integration test is intentionally skipped unless `BDA_RUN_HADOOP_INTEGRATION=1`, the Hadoop CLI is on `PATH`, and the project JAR exists. The app records per-job command, status, elapsed time, stdout/stderr, and HDFS output paths in `runs/<run_id>/run.json`.

## Verification Performed Here

- Python validation, output parsing, failure-handling, filters, run history, and environment compatibility: **17 passed**.
- Real Hadoop integration test: **1 skipped**, because this machine has no Hadoop/HDFS runtime or compiled JAR.
- Sample data generation and validation: **300/300 transaction lines accepted; 12/12 product rows accepted**.
- Larger data preparation check: **100,000/100,000 rows accepted**, 5,848,246-byte CSV; generation 0.429 s and validation 0.817 s on this Windows workspace. This measures Python synthetic data preparation/validation only, not Hadoop processing or analytics performance.
- Maven package: **BUILD SUCCESS** with Maven 3.9.15 and OpenJDK 11.0.30; verified JAR contains all three jobs at bytecode major version 55.
- Java MapReduce execution, HDFS smoke test, and successful full dashboard run: **not run**; Hadoop/WSL are unavailable in this Windows environment.

## Limitations

- The Hadoop runtime setup and successful end-to-end job execution still need to be completed in WSL2/Linux using the instructions above. Until then the dashboard correctly reports missing runtime components and shows no analytics.
- The join and ranking jobs use a single reducer for deterministic global ordering and global profit output; this is appropriate for the mini-project but limits throughput at very large scale.
- Exact distinct order counting stores each group's order IDs in reducer memory; exceptionally high-cardinality groups may require a multi-stage distinct-count design.
- CSV fields containing embedded line breaks are rejected; quoted commas and escaped quote characters are supported.
- The synthetic data is for demonstration only and makes no claims about any real retailer.